const express = require('express');
const cookieParser = require('cookie-parser');
const crypto = require('crypto');
const path = require('path');
const os = require('os');
const { put, del, list } = require('@vercel/blob');
const { handleUpload } = require('@vercel/blob/client');
const Anthropic = require('@anthropic-ai/sdk');

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

// Every gallery item, member, and chat message gets its own small JSON blob
// in Vercel Blob rather than a shared index file, since a shared file that
// every request rewrites lost data under concurrent writes (see git log).
//
// Editing an existing entity (title/description, profile picture, tester
// flag) never overwrites its file in place either. Overwriting a blob at
// the same pathname kept serving stale content on reads afterward, even
// through options specifically documented to guarantee a fresh read --
// confirmed by testing that a brand-new pathname is always readable
// immediately, while an overwritten one wasn't reliably. So an "edit" here
// means: write the new state to a new pathname inside that entity's own
// folder, then read the entity by listing its folder and taking the
// newest file. New pathnames need no conflict handling at all -- there's
// nothing to collide with -- which also means the conditional-write-with-
// retry logic from before is gone; it's no longer necessary.
const ITEMS_PREFIX = 'data/items/';
const MEMBERS_PREFIX = 'data/members/';
const CHAT_PREFIX = 'data/chat/';
const SUPPORT_PREFIX = 'data/support/';

// Set ANTHROPIC_API_KEY (an API key from console.anthropic.com) to enable
// the Support page's AI assistant. Constructed lazily so a missing/invalid
// key only breaks that one feature instead of crashing the whole server.
let anthropicClient = null;
function getAnthropicClient() {
  if (!anthropicClient) {
    anthropicClient = new Anthropic();
  }
  return anthropicClient;
}

const SUPPORT_SYSTEM_PROMPT = [
  'You are a friendly, concise support assistant built into "Autistically" --',
  'a small home/private photo and video gallery web app. Members join with',
  'just a name (no password), upload photos and videos, edit or delete their',
  'own uploads, set a profile picture, and -- if promoted by the owner -- use',
  'a group chat with other members. Help people troubleshoot bugs, explain',
  'how a feature works, and suggest next steps. If something sounds like it',
  'needs the site owner directly (data loss, a broken deploy, account',
  'access), say so plainly and suggest they contact the owner. Keep replies',
  'short and practical -- a few sentences unless real detail is needed.'
].join(' ');

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

function itemFolder(id) {
  return ITEMS_PREFIX + id + '/';
}

function memberFolder(name) {
  return MEMBERS_PREFIX + slugify(name) + '/';
}

function versionFilename() {
  return Date.now() + '-' + crypto.randomUUID().slice(0, 8) + '.json';
}

function writeJSONBlob(pathname, data, extraOptions) {
  return put(pathname, JSON.stringify(data, null, 2), Object.assign({
    access: 'public',
    addRandomSuffix: false,
    contentType: 'application/json'
  }, extraOptions));
}

async function fetchJSON(url) {
  // A cache-busting query string plus cache: 'no-store' -- belt and
  // suspenders, though the real fix is never re-fetching a pathname whose
  // content has changed (see comment above).
  const cacheBustedUrl = url + (url.indexOf('?') === -1 ? '?' : '&') + 'cb=' + Date.now();
  const res = await fetch(cacheBustedUrl, { cache: 'no-store' });
  return res.ok ? res.json() : null;
}

// Returns { pathname, data } for the newest file in a folder, or null if
// the folder is empty/doesn't exist yet.
async function getLatestInFolder(folder) {
  const { blobs } = await list({ prefix: folder });
  if (blobs.length === 0) {
    return null;
  }
  blobs.sort(function (a, b) {
    if (a.pathname < b.pathname) return 1;
    if (a.pathname > b.pathname) return -1;
    return 0;
  });
  const latest = blobs[0];
  const data = await fetchJSON(latest.url);
  return data ? { pathname: latest.pathname, url: latest.url, data: data } : null;
}

// Best-effort cleanup of superseded versions after writing a new one --
// not required for correctness (reads always pick the newest file), just
// keeps the store tidy.
async function pruneFolderExcept(folder, keepPathname) {
  const { blobs } = await list({ prefix: folder });
  const stale = blobs.filter(function (b) {
    return b.pathname !== keepPathname;
  });
  await Promise.all(stale.map(function (b) {
    return del(b.url).catch(function () {});
  }));
}

async function writeNewVersion(folder, data) {
  const pathname = folder + versionFilename();
  await writeJSONBlob(pathname, data, { allowOverwrite: false });
  return pathname;
}

async function listJSONBlobs(prefix) {
  const { blobs } = await list({ prefix: prefix });
  const results = await Promise.all(blobs.map(function (b) {
    return fetchJSON(b.url).then(function (data) {
      return { pathname: b.pathname, data: data };
    });
  }));
  return results.filter(function (r) {
    return r.data;
  });
}

async function getMediaItem(id) {
  const latest = await getLatestInFolder(itemFolder(id));
  return latest ? latest.data : null;
}

async function createMediaItem(entry) {
  const id = crypto.randomUUID();
  await writeNewVersion(itemFolder(id), entry);
  return id;
}

async function updateMediaItem(id, updateFn) {
  const folder = itemFolder(id);
  const latest = await getLatestInFolder(folder);
  if (!latest) {
    return null;
  }
  const updated = updateFn(latest.data);
  const newPathname = await writeNewVersion(folder, updated);
  await pruneFolderExcept(folder, newPathname);
  return updated;
}

async function deleteMediaItem(id, item) {
  const { blobs } = await list({ prefix: itemFolder(id) });
  await Promise.all(blobs.map(function (b) {
    return del(b.url).catch(function () {});
  }));
  if (item && item.url) {
    try {
      await del(item.url);
    } catch (err) {
      // Already gone -- nothing to do.
    }
  }
}

async function listMediaItems() {
  const { folders } = await list({ prefix: ITEMS_PREFIX, mode: 'folded' });
  const items = await Promise.all(folders.map(async function (folder) {
    const latest = await getLatestInFolder(folder);
    if (!latest) {
      return null;
    }
    const id = folder.slice(ITEMS_PREFIX.length).replace(/\/$/, '');
    return Object.assign({ id: id }, latest.data);
  }));
  return items.filter(Boolean);
}

async function findMember(name) {
  if (!name) {
    return null;
  }
  const latest = await getLatestInFolder(memberFolder(name));
  return latest ? latest.data : null;
}

async function addMember(name) {
  const folder = memberFolder(name);
  const existing = await getLatestInFolder(folder);
  if (existing) {
    return;
  }
  try {
    await writeNewVersion(folder, { name: name, joinedAt: Date.now(), profilePicture: '', isTester: false });
  } catch (err) {
    // Someone else joined under this exact name in the tiny gap between our
    // read and write -- fine, they're a member now either way.
  }
}

async function setMemberProfilePicture(name, url) {
  const folder = memberFolder(name);
  const existing = await getLatestInFolder(folder);
  const current = existing ? existing.data : { name: name, joinedAt: Date.now(), profilePicture: '', isTester: false };
  const oldUrl = current.profilePicture || null;
  const updated = Object.assign({}, current, { profilePicture: url });
  const newPathname = await writeNewVersion(folder, updated);
  await pruneFolderExcept(folder, newPathname);
  if (oldUrl) {
    try {
      await del(oldUrl);
    } catch (err) {
      // Old picture already gone or unreachable -- nothing to do.
    }
  }
}

async function setMemberTester(name, isTester) {
  const folder = memberFolder(name);
  const existing = await getLatestInFolder(folder);
  if (!existing) {
    return;
  }
  const updated = Object.assign({}, existing.data, { isTester: !!isTester });
  const newPathname = await writeNewVersion(folder, updated);
  await pruneFolderExcept(folder, newPathname);
}

async function listMembers() {
  const { folders } = await list({ prefix: MEMBERS_PREFIX, mode: 'folded' });
  const members = await Promise.all(folders.map(async function (folder) {
    const latest = await getLatestInFolder(folder);
    return latest ? latest.data : null;
  }));
  return members.filter(Boolean);
}

async function createChatMessage(entry) {
  const id = crypto.randomUUID();
  await writeJSONBlob(CHAT_PREFIX + id + '.json', entry, { allowOverwrite: false });
  return id;
}

async function listChatMessages() {
  const entries = await listJSONBlobs(CHAT_PREFIX);
  return entries
    .map(function (entry) {
      const id = entry.pathname.slice(CHAT_PREFIX.length, -'.json'.length);
      return Object.assign({ id: id }, entry.data);
    })
    .sort(function (a, b) {
      return (a.postedAt || 0) - (b.postedAt || 0);
    });
}

function supportFolder(name) {
  return SUPPORT_PREFIX + slugify(name) + '/';
}

async function listSupportMessages(name) {
  const entries = await listJSONBlobs(supportFolder(name));
  return entries
    .map(function (entry) {
      return entry.data;
    })
    .sort(function (a, b) {
      return (a.postedAt || 0) - (b.postedAt || 0);
    });
}

function saveSupportMessage(name, entry) {
  return writeJSONBlob(supportFolder(name) + crypto.randomUUID() + '.json', entry, { allowOverwrite: false });
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

// Testers are members the owner has manually flagged (see the toggle on
// /members) -- there's no separate key/cookie for it, tester status is
// just read off the member's own record each time. The owner always
// counts as a tester too, so they're never locked out of the chat page.
async function getAccessFlags(req) {
  const currentMember = req.cookies.memberName || null;
  const owner = isSiteOwner(req);
  let tester = owner;
  if (!tester && currentMember) {
    const member = await findMember(currentMember);
    tester = !!(member && member.isTester);
  }
  return { currentMember: currentMember, isOwner: owner, isTester: tester };
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
  const access = await getAccessFlags(req);
  const items = await getGalleryItems(access.currentMember, access.isOwner);
  res.render('gallery', Object.assign({ items: items, error: req.query.error || null }, access));
});

app.get('/add', async function (req, res) {
  res.render('add', await getAccessFlags(req));
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
  const access = await getAccessFlags(req);
  const entry = await getMediaItem(req.params.id);
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, access.currentMember) && !access.isOwner) {
    return res.redirect('/?error=' + encodeURIComponent('You can only edit items you added.'));
  }
  res.render('edit', Object.assign({
    id: req.params.id,
    url: entry.url,
    type: entry.contentType && entry.contentType.indexOf('video/') === 0 ? 'video' : 'image',
    title: entry.title || '',
    description: entry.description || ''
  }, access));
});

app.post('/edit/:id', async function (req, res) {
  const access = await getAccessFlags(req);
  const entry = await getMediaItem(req.params.id);
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, access.currentMember) && !access.isOwner) {
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
  const access = await getAccessFlags(req);
  const entry = await getMediaItem(req.params.id);
  if (!entry) {
    return res.redirect('/');
  }
  if (!canManageItem(entry, access.currentMember) && !access.isOwner) {
    return res.redirect('/?error=' + encodeURIComponent('You can only delete items you added.'));
  }
  await deleteMediaItem(req.params.id, entry);
  res.redirect('/');
});

app.get('/join', async function (req, res) {
  res.render('join', Object.assign({ error: null }, await getAccessFlags(req)));
});

app.post('/join', async function (req, res) {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.render('join', Object.assign({ error: 'Please enter a name.' }, await getAccessFlags(req)));
  }
  await addMember(name);
  res.cookie('memberName', name, { maxAge: MEMBER_COOKIE_MAX_AGE });
  res.redirect('/members');
});

app.get('/members', async function (req, res) {
  const access = await getAccessFlags(req);
  const members = (await listMembers())
    .slice()
    .sort(function (a, b) {
      return a.joinedAt - b.joinedAt;
    })
    .map(function (m) {
      return { name: m.name, pictureUrl: m.profilePicture || '', isTester: !!m.isTester };
    });
  res.render('members', Object.assign({ members: members }, access));
});

app.post('/members/:name/tester', async function (req, res) {
  if (!isSiteOwner(req)) {
    return res.status(403).send('Only the owner can do that.');
  }
  await setMemberTester(req.params.name, req.body.enable === 'true');
  res.redirect('/members');
});

app.get('/profile', async function (req, res) {
  const access = await getAccessFlags(req);
  if (!access.currentMember) {
    return res.redirect('/join');
  }
  const member = await findMember(access.currentMember);
  res.render('profile', Object.assign({
    pictureUrl: member && member.profilePicture ? member.profilePicture : ''
  }, access));
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

app.get('/chat', async function (req, res) {
  const access = await getAccessFlags(req);
  if (!access.isTester) {
    return res.redirect('/?error=' + encodeURIComponent('Chat is for testers only.'));
  }
  const messages = await listChatMessages();
  res.render('chat', Object.assign({ messages: messages }, access));
});

// Polled by views/chat.ejs every few seconds to pick up new messages.
app.get('/api/chat/messages', async function (req, res) {
  const access = await getAccessFlags(req);
  if (!access.isTester) {
    return res.status(403).json({ error: 'Testers only.' });
  }
  const messages = await listChatMessages();
  res.json({ messages: messages });
});

app.post('/chat', async function (req, res) {
  const access = await getAccessFlags(req);
  if (!access.isTester) {
    return res.status(403).json({ error: 'Testers only.' });
  }
  const author = access.currentMember || (access.isOwner ? 'Owner' : null);
  if (!author) {
    return res.status(400).json({ error: 'Join first so your messages have a name.' });
  }
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Message is empty.' });
  }
  if (text.length > 2000) {
    return res.status(400).json({ error: 'Message is too long.' });
  }
  const id = await createChatMessage({ author: author, text: text, postedAt: Date.now() });
  res.json({ id: id });
});

app.get('/support', async function (req, res) {
  const access = await getAccessFlags(req);
  if (!access.currentMember) {
    return res.redirect('/join');
  }
  const messages = await listSupportMessages(access.currentMember);
  res.render('support', Object.assign({ messages: messages }, access));
});

app.post('/support', async function (req, res) {
  const access = await getAccessFlags(req);
  if (!access.currentMember) {
    return res.status(401).json({ error: 'Join first.' });
  }
  const text = String((req.body && req.body.text) || '').trim();
  if (!text) {
    return res.status(400).json({ error: 'Message is empty.' });
  }
  if (text.length > 4000) {
    return res.status(400).json({ error: 'Message is too long.' });
  }

  await saveSupportMessage(access.currentMember, { role: 'user', text: text, postedAt: Date.now() });

  const history = await listSupportMessages(access.currentMember);
  const claudeMessages = history.map(function (m) {
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text };
  });

  let replyText;
  try {
    const response = await getAnthropicClient().messages.create({
      model: 'claude-opus-5',
      max_tokens: 2048,
      output_config: { effort: 'medium' },
      system: SUPPORT_SYSTEM_PROMPT,
      messages: claudeMessages
    });
    if (response.stop_reason === 'refusal') {
      replyText = "I can't help with that particular request, sorry -- try rephrasing or describing the bug differently.";
    } else {
      const textBlock = response.content.find(function (block) {
        return block.type === 'text';
      });
      replyText = textBlock ? textBlock.text : "Sorry, I didn't get a usable response. Please try again.";
    }
  } catch (err) {
    console.error(err);
    replyText = 'Sorry, the support assistant is temporarily unavailable. Please try again in a moment.';
  }

  await saveSupportMessage(access.currentMember, { role: 'assistant', text: replyText, postedAt: Date.now() });

  res.json({ reply: replyText });
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
