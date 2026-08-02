const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { put, head, del, list, BlobNotFoundError, BlobPreconditionFailedError } = require('@vercel/blob');
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

// Every gallery item and every member gets its OWN small JSON blob, instead
// of one shared index file everyone's requests would have to read-modify-
// write. That shared-file design lost data under concurrent writes even
// with conditional-write retries, because Vercel Blob reads (even ones
// documented to bypass caching) kept returning stale content in testing --
// a fresh item/member never needs a conditional write at all, since it's a
// brand-new pathname nothing else can collide with. Edits only risk
// colliding with another edit of that exact same item/member, which is a
// far narrower window.
const ITEMS_PREFIX = 'data/items/';
const MEMBERS_PREFIX = 'data/members/';

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function slugify(name) {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'member';
}

function memberPathname(name) {
  return MEMBERS_PREFIX + slugify(name) + '.json';
}

async function headBlob(pathname) {
  try {
    return await head(pathname);
  } catch (err) {
    if (err instanceof BlobNotFoundError || err.name === 'BlobNotFoundError') {
      return null;
    }
    throw err;
  }
}

async function fetchBlobJSON(info, fallback) {
  if (!info) {
    return fallback;
  }
  // A cache-busting query string plus cache: 'no-store' -- belt and
  // suspenders against getting a stale cached copy right after a write.
  const cacheBustedUrl = info.url + (info.url.indexOf('?') === -1 ? '?' : '&') + 'cb=' + Date.now();
  const res = await fetch(cacheBustedUrl, { cache: 'no-store' });
  if (!res.ok) {
    return fallback;
  }
  return await res.json();
}

async function readJSONBlob(pathname, fallback) {
  const info = await headBlob(pathname);
  return fetchBlobJSON(info, fallback);
}

function writeJSONBlob(pathname, data, extraOptions) {
  return put(pathname, JSON.stringify(data, null, 2), Object.assign({
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json'
  }, extraOptions));
}

function wait(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

function isConflictError(err) {
  // Checking err.name/message as well as instanceof: errors that cross an
  // async boundary inside a dependency don't always preserve the exact
  // class reference, so instanceof alone silently failed to catch these
  // in testing.
  return err instanceof BlobPreconditionFailedError || err.name === 'BlobPreconditionFailedError' || err.status === 412 || /precondition/i.test(err.message || '');
}

// Only used for editing an existing item/member, where the only possible
// collision is someone else editing that exact same one at the exact same
// moment -- a far narrower window than contending over one shared file.
async function updateJSONBlob(pathname, fallback, updateFn) {
  const MAX_ATTEMPTS = 8;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const info = await headBlob(pathname);
    const current = await fetchBlobJSON(info, fallback);
    const updated = updateFn(current);
    const options = { allowOverwrite: true };
    if (info) {
      options.ifMatch = info.etag;
    }
    try {
      await writeJSONBlob(pathname, updated, options);
      return updated;
    } catch (err) {
      if (isConflictError(err) && attempt < MAX_ATTEMPTS) {
        await wait(Math.floor(Math.random() * 100 * attempt));
        continue;
      }
      throw err;
    }
  }
}

async function listJSONBlobs(prefix) {
  const { blobs } = await list({ prefix: prefix });
  const results = await Promise.all(blobs.map(function (b) {
    const cacheBustedUrl = b.url + (b.url.indexOf('?') === -1 ? '?' : '&') + 'cb=' + Date.now();
    return fetch(cacheBustedUrl, { cache: 'no-store' })
      .then(function (res) {
        return res.ok ? res.json() : null;
      })
      .then(function (data) {
        return { pathname: b.pathname, data: data };
      })
      .catch(function () {
        return { pathname: b.pathname, data: null };
      });
  }));
  return results.filter(function (r) {
    return r.data;
  });
}

async function getMediaItem(id) {
  return readJSONBlob(ITEMS_PREFIX + id + '.json', null);
}

async function createMediaItem(entry) {
  const id = crypto.randomUUID();
  await writeJSONBlob(ITEMS_PREFIX + id + '.json', entry, { allowOverwrite: false });
  return id;
}

function updateMediaItem(id, updateFn) {
  return updateJSONBlob(ITEMS_PREFIX + id + '.json', null, function (current) {
    return current ? updateFn(current) : current;
  });
}

async function deleteMediaItem(id, item) {
  try {
    await del(ITEMS_PREFIX + id + '.json');
  } catch (err) {
    // Already gone -- nothing to do.
  }
  if (item && item.url) {
    try {
      await del(item.url);
    } catch (err) {
      // Already gone -- nothing to do.
    }
  }
}

async function listMediaItems() {
  const entries = await listJSONBlobs(ITEMS_PREFIX);
  return entries.map(function (entry) {
    const id = entry.pathname.slice(ITEMS_PREFIX.length, -'.json'.length);
    return Object.assign({ id: id }, entry.data);
  });
}

async function findMember(name) {
  if (!name) {
    return null;
  }
  return readJSONBlob(memberPathname(name), null);
}

async function addMember(name) {
  const pathname = memberPathname(name);
  const existing = await readJSONBlob(pathname, null);
  if (existing) {
    return;
  }
  try {
    await writeJSONBlob(pathname, { name: name, joinedAt: Date.now(), profilePicture: '' }, { allowOverwrite: false });
  } catch (err) {
    // Someone else joined under this exact name in the tiny gap between our
    // read and write -- fine, they're a member now either way.
  }
}

async function setMemberProfilePicture(name, url) {
  let oldUrl = null;
  await updateJSONBlob(memberPathname(name), { name: name, joinedAt: Date.now(), profilePicture: '' }, function (current) {
    oldUrl = current.profilePicture || null;
    return Object.assign({}, current, { profilePicture: url });
  });
  if (oldUrl) {
    try {
      await del(oldUrl);
    } catch (err) {
      // Old picture already gone or unreachable -- nothing to do.
    }
  }
}

async function listMembers() {
  const entries = await listJSONBlobs(MEMBERS_PREFIX);
  return entries.map(function (entry) {
    return entry.data;
  });
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
  const [items, members] = await Promise.all([listMediaItems(), listMembers()]);
  return items
    .map(function (entry) {
      const addedBy = entry.addedBy || '';
      const uploader = addedBy ? members.find(m => m.name.toLowerCase() === addedBy.toLowerCase()) : null;
      const item = {
        id: entry.id,
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
  res.render('gallery', { items: items, currentMember: currentMember, isOwner: isSiteOwner(req), error: req.query.error || null });
});

app.get('/add', function (req, res) {
  res.render('add', { currentMember: req.cookies.memberName || null, isOwner: isSiteOwner(req) });
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
  const id = await createMediaItem({
    url: body.url,
    contentType: body.contentType || '',
    title: String(body.title || '').trim(),
    description: String(body.description || '').trim(),
    addedBy: req.cookies.memberName || '',
    uploadedAt: Date.now()
  });
  res.json({ id: id });
});

app.get('/edit/:id', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const entry = await getMediaItem(req.params.id);
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
    currentMember: currentMember,
    isOwner: isSiteOwner(req)
  });
});

app.post('/edit/:id', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const entry = await getMediaItem(req.params.id);
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only edit items you added.'));
  }
  const title = (req.body.title || '').trim();
  const description = (req.body.description || '').trim();
  await updateMediaItem(req.params.id, function (current) {
    return Object.assign({}, current, { title: title, description: description });
  });
  res.redirect('/');
});

app.post('/delete/:id', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  const entry = await getMediaItem(req.params.id);
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only delete items you added.'));
  }
  await deleteMediaItem(req.params.id, entry);
  res.redirect('/');
});

app.get('/join', function (req, res) {
  res.render('join', { error: null, currentMember: req.cookies.memberName || null, isOwner: isSiteOwner(req) });
});

app.post('/join', async function (req, res) {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.render('join', { error: 'Please enter a name.', currentMember: req.cookies.memberName || null, isOwner: isSiteOwner(req) });
  }
  await addMember(name);
  res.cookie('memberName', name, { maxAge: MEMBER_COOKIE_MAX_AGE });
  res.redirect('/members');
});

app.get('/members', async function (req, res) {
  const members = (await listMembers())
    .slice()
    .sort(function (a, b) {
      return a.joinedAt - b.joinedAt;
    })
    .map(function (m) {
      return { name: m.name, pictureUrl: m.profilePicture || '' };
    });
  res.render('members', { members: members, currentMember: req.cookies.memberName || null, isOwner: isSiteOwner(req) });
});

app.get('/profile', async function (req, res) {
  const currentMember = req.cookies.memberName || null;
  if (!currentMember) {
    return res.redirect('/join');
  }
  const member = await findMember(currentMember);
  res.render('profile', {
    currentMember: currentMember,
    pictureUrl: member && member.profilePicture ? member.profilePicture : '',
    isOwner: isSiteOwner(req)
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
