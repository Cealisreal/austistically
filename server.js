const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { put, head, del, BlobNotFoundError } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');

const app = express();
const PORT = process.env.PORT || 3000;
const MEMBER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
// Optional: set the OWNER_KEY environment variable to a private secret you
// choose, then visit /owner?key=<that secret> once on a device to unlock
// permanent edit/delete rights over every item, regardless of who added it.
// Leave OWNER_KEY unset to disable this entirely.
const OWNER_KEY = process.env.OWNER_KEY || '';

const IMAGE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'];
const VIDEO_CONTENT_TYPES = ['video/mp4', 'video/quicktime', 'video/webm'];
const MEDIA_CONTENT_TYPES = IMAGE_CONTENT_TYPES.concat(VIDEO_CONTENT_TYPES);
const MAX_MEDIA_SIZE = 500 * 1024 * 1024; // 500MB, generous for phone videos
const MAX_PROFILE_SIZE = 10 * 1024 * 1024; // 10MB, plenty for a profile picture

// All app data (the gallery index and the member list) lives in two small
// JSON files stored in Vercel Blob, not on local disk -- there is no
// persistent local disk on Vercel. The actual photos/videos/profile pictures
// are uploaded directly from the browser to Blob storage (see the upload
// scripts in views/add.ejs and views/profile.ejs), bypassing this server
// entirely, since Vercel Functions reject request bodies over 4.5MB.
const METADATA_PATHNAME = 'data/metadata.json';
const MEMBERS_PATHNAME = 'data/members.json';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

async function readJSONBlob(pathname, fallback) {
  try {
    const info = await head(pathname);
    const res = await fetch(info.url);
    if (!res.ok) {
      return fallback;
    }
    return await res.json();
  } catch (err) {
    if (err instanceof BlobNotFoundError) {
      return fallback;
    }
    throw err;
  }
}

function writeJSONBlob(pathname, data) {
  return put(pathname, JSON.stringify(data, null, 2), {
    access: 'public',
    addRandomSuffix: false,
    allowOverwrite: true,
    contentType: 'application/json'
  });
}

function readMetadata() {
  return readJSONBlob(METADATA_PATHNAME, {});
}

function writeMetadata(data) {
  return writeJSONBlob(METADATA_PATHNAME, data);
}

function readMembers() {
  return readJSONBlob(MEMBERS_PATHNAME, []);
}

function writeMembers(data) {
  return writeJSONBlob(MEMBERS_PATHNAME, data);
}

async function addMember(name) {
  const members = await readMembers();
  const alreadyMember = members.some(m => m.name.toLowerCase() === name.toLowerCase());
  if (!alreadyMember) {
    members.push({ name: name, joinedAt: Date.now(), profilePicture: '' });
    await writeMembers(members);
  }
}

async function findMember(name) {
  if (!name) {
    return null;
  }
  const members = await readMembers();
  return members.find(m => m.name.toLowerCase() === name.toLowerCase()) || null;
}

async function setMemberProfilePicture(name, url) {
  const members = await readMembers();
  const member = members.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (!member) {
    return;
  }
  const oldUrl = member.profilePicture;
  member.profilePicture = url;
  await writeMembers(members);
  if (oldUrl) {
    try {
      await del(oldUrl);
    } catch (err) {
      // Old picture already gone or unreachable -- nothing to do.
    }
  }
}

function canManageItem(item, memberName) {
  if (!item.addedBy) {
    return true;
  }
  return !!memberName && item.addedBy.toLowerCase() === memberName.toLowerCase();
}

function isSiteOwner(req) {
  return !!OWNER_KEY && req.cookies.ownerKey === OWNER_KEY;
}

async function getGalleryItems(currentMember, ownerOverride) {
  const [metadata, members] = await Promise.all([readMetadata(), readMembers()]);
  return Object.keys(metadata)
    .map(function (id) {
      const entry = metadata[id];
      const addedBy = entry.addedBy || '';
      const uploader = addedBy ? members.find(m => m.name.toLowerCase() === addedBy.toLowerCase()) : null;
      const item = {
        id: id,
        url: entry.url,
        type: entry.contentType && entry.contentType.indexOf('video/') === 0 ? 'video' : 'image',
        title: entry.title || '',
        description: entry.description || '',
        addedBy: addedBy,
        addedByPicture: uploader && uploader.profilePicture ? uploader.profilePicture : '',
        uploadedAt: entry.uploadedAt || 0
      };
      item.canManage = canManageItem(item, currentMember) || !!ownerOverride;
      return item;
    })
    .sort(function (a, b) {
      return b.uploadedAt - a.uploadedAt;
    });
}

function getLanIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return 'localhost';
}

app.get('/', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const items = await getGalleryItems(currentMember, isSiteOwner(req));
  res.render('gallery', { items: items, currentMember: currentMember, error: req.query.error || null });
});

app.get('/add', function (req, res) {
  res.render('add', { currentMember: req.cookies.memberName || null });
});

// Called by the browser (see views/add.ejs) before it uploads a file
// directly to Vercel Blob. Issues a short-lived upload token.
app.post('/api/media-upload-token', async function (req, res) {
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async function () {
        return {
          allowedContentTypes: MEDIA_CONTENT_TYPES,
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_MEDIA_SIZE
        };
      },
      onUploadCompleted: async function () {
        // Intentionally empty: this callback is called by Vercel Blob over
        // the network, so it never fires for local development. The browser
        // instead calls POST /api/media itself once the upload finishes,
        // which works the same way locally and when deployed.
      }
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Called by the browser after a direct-to-Blob upload finishes, with the
// resulting blob URL, to record the gallery entry.
app.post('/api/media', async function (req, res) {
  const body = req.body || {};
  if (!body.url) {
    return res.status(400).json({ error: 'Missing upload URL.' });
  }
  const id = crypto.randomUUID();
  const metadata = await readMetadata();
  metadata[id] = {
    url: body.url,
    contentType: body.contentType || '',
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    addedBy: req.cookies.memberName || '',
    uploadedAt: Date.now()
  };
  await writeMetadata(metadata);
  res.json({ id: id });
});

app.get('/edit/:id', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const metadata = await readMetadata();
  const entry = metadata[req.params.id];
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only edit items you added.'));
  }
  res.render('edit', {
    id: req.params.id,
    url: entry.url,
    type: entry.contentType && entry.contentType.indexOf('video/') === 0 ? 'video' : 'image',
    title: entry.title || '',
    description: entry.description || '',
    currentMember: currentMember
  });
});

app.post('/edit/:id', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const metadata = await readMetadata();
  const entry = metadata[req.params.id];
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only edit items you added.'));
  }
  entry.title = (req.body.title || '').trim();
  entry.description = (req.body.description || '').trim();
  await writeMetadata(metadata);
  res.redirect('/');
});

app.post('/delete/:id', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const metadata = await readMetadata();
  const entry = metadata[req.params.id];
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only delete items you added.'));
  }
  delete metadata[req.params.id];
  await writeMetadata(metadata);
  try {
    await del(entry.url);
  } catch (err) {
    // Already gone -- nothing to do.
  }
  res.redirect('/');
});

app.get('/join', function (req, res) {
  res.render('join', { error: null, currentMember: req.cookies.memberName || null });
});

app.post('/join', async function (req, res) {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.render('join', { error: 'Please enter a name.', currentMember: req.cookies.memberName || null });
  }
  await addMember(name);
  res.cookie('memberName', name, { maxAge: MEMBER_COOKIE_MAX_AGE });
  res.redirect('/members');
});

app.get('/members', async function (req, res) {
  const members = (await readMembers())
    .slice()
    .sort(function (a, b) {
      return a.joinedAt - b.joinedAt;
    })
    .map(function (m) {
      return { name: m.name, pictureUrl: m.profilePicture || '' };
    });
  res.render('members', { members: members, currentMember: req.cookies.memberName || null });
});

app.get('/profile', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  if (!currentMember) {
    return res.redirect('/join');
  }
  const member = await findMember(currentMember);
  res.render('profile', {
    currentMember: currentMember,
    pictureUrl: member && member.profilePicture ? member.profilePicture : ''
  });
});

app.post('/api/profile-upload-token', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  if (!currentMember) {
    return res.status(401).json({ error: 'Join first.' });
  }
  try {
    const jsonResponse = await handleUpload({
      body: req.body,
      request: req,
      onBeforeGenerateToken: async function () {
        return {
          allowedContentTypes: IMAGE_CONTENT_TYPES,
          addRandomSuffix: true,
          maximumSizeInBytes: MAX_PROFILE_SIZE
        };
      },
      onUploadCompleted: async function () {}
    });
    res.json(jsonResponse);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/profile-picture', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  if (!currentMember) {
    return res.status(401).json({ error: 'Join first.' });
  }
  const url = req.body && req.body.url;
  if (!url) {
    return res.status(400).json({ error: 'Missing upload URL.' });
  }
  await setMemberProfilePicture(currentMember, url);
  res.json({ ok: true });
});

app.get('/owner', function (req, res) {
  if (!OWNER_KEY) {
    return res.status(404).send('Not found');
  }
  if (req.query.key !== OWNER_KEY) {
    return res.status(403).send('Incorrect key.');
  }
  res.cookie('ownerKey', OWNER_KEY, { maxAge: MEMBER_COOKIE_MAX_AGE, httpOnly: true });
  res.redirect('/');
});

// Express 5 forwards errors thrown by async route handlers here automatically.
app.use(function (err, req, res, next) {
  console.error(err);
  res.status(500).send('Something went wrong. Please try again.');
});

app.listen(PORT, '0.0.0.0', function () {
  console.log('Server running on port ' + PORT);
  if (!process.env.PORT) {
    // No PORT was assigned by a hosting platform, so this is a local run.
    const lanIP = getLanIP();
    console.log('On this computer: http://localhost:' + PORT);
    console.log('Share with others on your wifi: http://' + lanIP + ':' + PORT);
  }
});
