const express = require('express');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const path = require('path');
const fs = require('fs');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 3000;
// DATA_DIR is where photos/videos/profile pictures and their metadata live.
// Locally this defaults to the project folder. When deployed to a host like
// Render, set DATA_DIR to the mount path of a persistent disk so uploads
// survive redeploys.
const DATA_DIR = process.env.DATA_DIR || __dirname;
const MEDIA_DIR = path.join(DATA_DIR, 'media');
const PROFILES_DIR = path.join(DATA_DIR, 'profiles');
const METADATA_FILE = path.join(DATA_DIR, 'metadata.json');
const MEMBERS_FILE = path.join(DATA_DIR, 'members.json');
const MEMBER_COOKIE_MAX_AGE = 365 * 24 * 60 * 60 * 1000; // 1 year
// Optional: set the OWNER_KEY environment variable to a private secret you
// choose, then visit /owner?key=<that secret> once on a device to unlock
// permanent edit/delete rights over every item, regardless of who added it.
// Leave OWNER_KEY unset to disable this entirely.
const OWNER_KEY = process.env.OWNER_KEY || '';

fs.mkdirSync(MEDIA_DIR, { recursive: true });
fs.mkdirSync(PROFILES_DIR, { recursive: true });

const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
const VIDEO_EXTENSIONS = ['.mp4', '.mov', '.webm'];
const ALLOWED_EXTENSIONS = IMAGE_EXTENSIONS.concat(VIDEO_EXTENSIONS);

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use('/media', express.static(MEDIA_DIR));
app.use('/profiles', express.static(PROFILES_DIR));
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

function sanitizeFilename(name) {
  return name.replace(/[^a-zA-Z0-9.\-_]/g, '_');
}

function readMetadata() {
  if (!fs.existsSync(METADATA_FILE)) {
    return {};
  }
  return JSON.parse(fs.readFileSync(METADATA_FILE, 'utf8'));
}

function saveMetadata(filename, title, description, addedBy) {
  const metadata = readMetadata();
  metadata[filename] = { title: title, description: description, addedBy: addedBy || '' };
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

function deleteMetadata(filename) {
  const metadata = readMetadata();
  delete metadata[filename];
  fs.writeFileSync(METADATA_FILE, JSON.stringify(metadata, null, 2));
}

function readMembers() {
  if (!fs.existsSync(MEMBERS_FILE)) {
    return [];
  }
  return JSON.parse(fs.readFileSync(MEMBERS_FILE, 'utf8'));
}

function addMember(name) {
  const members = readMembers();
  const alreadyMember = members.some(m => m.name.toLowerCase() === name.toLowerCase());
  if (!alreadyMember) {
    members.push({ name: name, joinedAt: Date.now(), profilePicture: '' });
    fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
  }
}

function findMember(name) {
  if (!name) {
    return null;
  }
  return readMembers().find(m => m.name.toLowerCase() === name.toLowerCase()) || null;
}

function setMemberProfilePicture(name, filename) {
  const members = readMembers();
  const member = members.find(m => m.name.toLowerCase() === name.toLowerCase());
  if (!member) {
    return;
  }
  if (member.profilePicture) {
    const oldPath = path.join(PROFILES_DIR, member.profilePicture);
    if (fs.existsSync(oldPath)) {
      fs.unlinkSync(oldPath);
    }
  }
  member.profilePicture = filename;
  fs.writeFileSync(MEMBERS_FILE, JSON.stringify(members, null, 2));
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

const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, MEDIA_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + sanitizeFilename(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB, generous for phone videos
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('That file type is not allowed. Please upload a photo (jpg, png, gif, webp) or video (mp4, mov, webm).'));
    }
  }
});

const profileStorage = multer.diskStorage({
  destination: function (req, file, cb) {
    cb(null, PROFILES_DIR);
  },
  filename: function (req, file, cb) {
    cb(null, Date.now() + '-' + sanitizeFilename(file.originalname));
  }
});

const profileUpload = multer({
  storage: profileStorage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB, plenty for a profile picture
  fileFilter: function (req, file, cb) {
    const ext = path.extname(file.originalname).toLowerCase();
    if (IMAGE_EXTENSIONS.includes(ext)) {
      cb(null, true);
    } else {
      cb(new Error('Profile pictures must be a photo (jpg, png, gif, webp).'));
    }
  }
});

function getGalleryItems(currentMember, ownerOverride) {
  const files = fs.readdirSync(MEDIA_DIR);
  const metadata = readMetadata();
  return files
    .filter(name => ALLOWED_EXTENSIONS.includes(path.extname(name).toLowerCase()))
    .map(name => {
      const stats = fs.statSync(path.join(MEDIA_DIR, name));
      const ext = path.extname(name).toLowerCase();
      const entry = metadata[name] || {};
      const addedBy = entry.addedBy || '';
      const uploader = addedBy ? findMember(addedBy) : null;
      const item = {
        filename: name,
        url: '/media/' + encodeURIComponent(name),
        type: IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'video',
        title: entry.title || '',
        description: entry.description || '',
        addedBy: addedBy,
        addedByPicture: uploader && uploader.profilePicture ? '/profiles/' + encodeURIComponent(uploader.profilePicture) : '',
        mtime: stats.mtimeMs
      };
      item.canManage = canManageItem(item, currentMember) || ownerOverride;
      return item;
    })
    .sort((a, b) => b.mtime - a.mtime);
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

app.get('/', function (req, res) {
  const currentMember = req.cookies.memberName || null;
  res.render('gallery', { items: getGalleryItems(currentMember, isSiteOwner(req)), currentMember: currentMember, error: req.query.error || null });
});

app.get('/add', function (req, res) {
  res.render('add', { error: null, currentMember: req.cookies.memberName || null });
});

app.post('/add', function (req, res) {
  upload.single('media')(req, res, function (err) {
    if (err) {
      return res.render('add', { error: err.message, currentMember: req.cookies.memberName || null });
    }
    if (!req.file) {
      return res.render('add', { error: 'Please choose a photo or video to upload.', currentMember: req.cookies.memberName || null });
    }
    saveMetadata(req.file.filename, (req.body.title || '').trim(), (req.body.description || '').trim(), req.cookies.memberName);
    res.redirect('/');
  });
});

app.get('/edit/:filename', function (req, res) {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.redirect('/');
  }
  const currentMember = req.cookies.memberName || null;
  const entry = readMetadata()[filename] || {};
  if (!canManageItem({ addedBy: entry.addedBy || '' }, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only edit items you added.'));
  }
  const ext = path.extname(filename).toLowerCase();
  res.render('edit', {
    filename: filename,
    url: '/media/' + encodeURIComponent(filename),
    type: IMAGE_EXTENSIONS.includes(ext) ? 'image' : 'video',
    title: entry.title || '',
    description: entry.description || '',
    currentMember: currentMember
  });
});

app.post('/edit/:filename', function (req, res) {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(MEDIA_DIR, filename);
  if (!fs.existsSync(filePath)) {
    return res.redirect('/');
  }
  const currentMember = req.cookies.memberName || null;
  const existing = readMetadata()[filename] || {};
  if (!canManageItem({ addedBy: existing.addedBy || '' }, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only edit items you added.'));
  }
  saveMetadata(filename, (req.body.title || '').trim(), (req.body.description || '').trim(), existing.addedBy);
  res.redirect('/');
});

app.post('/delete/:filename', function (req, res) {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(MEDIA_DIR, filename);
  const currentMember = req.cookies.memberName || null;
  const existing = readMetadata()[filename] || {};
  if (!canManageItem({ addedBy: existing.addedBy || '' }, currentMember) && !isSiteOwner(req)) {
    return res.redirect('/?error=' + encodeURIComponent('You can only delete items you added.'));
  }
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  deleteMetadata(filename);
  res.redirect('/');
});

app.get('/join', function (req, res) {
  res.render('join', { error: null, currentMember: req.cookies.memberName || null });
});

app.post('/join', function (req, res) {
  const name = (req.body.name || '').trim();
  if (!name) {
    return res.render('join', { error: 'Please enter a name.', currentMember: req.cookies.memberName || null });
  }
  addMember(name);
  res.cookie('memberName', name, { maxAge: MEMBER_COOKIE_MAX_AGE });
  res.redirect('/members');
});

app.get('/members', function (req, res) {
  const members = readMembers()
    .sort((a, b) => a.joinedAt - b.joinedAt)
    .map(m => ({
      name: m.name,
      pictureUrl: m.profilePicture ? '/profiles/' + encodeURIComponent(m.profilePicture) : ''
    }));
  res.render('members', { members: members, currentMember: req.cookies.memberName || null });
});

app.get('/profile', function (req, res) {
  const currentMember = req.cookies.memberName || null;
  if (!currentMember) {
    return res.redirect('/join');
  }
  const member = findMember(currentMember);
  res.render('profile', {
    currentMember: currentMember,
    pictureUrl: member && member.profilePicture ? '/profiles/' + encodeURIComponent(member.profilePicture) : '',
    error: null
  });
});

app.post('/profile', function (req, res) {
  const currentMember = req.cookies.memberName || null;
  if (!currentMember) {
    return res.redirect('/join');
  }
  profileUpload.single('picture')(req, res, function (err) {
    const member = findMember(currentMember);
    if (err) {
      return res.render('profile', {
        currentMember: currentMember,
        pictureUrl: member && member.profilePicture ? '/profiles/' + encodeURIComponent(member.profilePicture) : '',
        error: err.message
      });
    }
    if (!req.file) {
      return res.render('profile', {
        currentMember: currentMember,
        pictureUrl: member && member.profilePicture ? '/profiles/' + encodeURIComponent(member.profilePicture) : '',
        error: 'Please choose a picture to upload.'
      });
    }
    setMemberProfilePicture(currentMember, req.file.filename);
    res.redirect('/profile');
  });
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

app.listen(PORT, '0.0.0.0', function () {
  console.log('Server running on port ' + PORT);
  if (!process.env.PORT) {
    // No PORT was assigned by a hosting platform, so this is a local run.
    const lanIP = getLanIP();
    console.log('On this computer: http://localhost:' + PORT);
    console.log('Share with others on your wifi: http://' + lanIP + ':' + PORT);
  }
});
