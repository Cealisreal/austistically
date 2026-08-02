# Gallery

A simple photo/video gallery. Anyone with the link can view and add photos or
videos; joining lets you get credit for what you add and set a profile picture.

## Running it locally

```bash
npm install
npm start
```

Then open `http://localhost:3000`.

## Deploying so it's reachable from anywhere (not just your wifi)

This app is ready to deploy to [Render](https://render.com) as a Web Service.
Render was not free-tier friendly for this: **persistent disks (needed so your
uploads survive redeploys) require a paid Render plan** — check
[render.com/pricing](https://render.com/pricing) for current costs before you
commit to this.

### 1. Put the project on GitHub

Render deploys from a GitHub repo. Run these yourself in this folder:

```bash
git init
git add .
git commit -m "Initial commit"
```

Then create a new repository on [github.com/new](https://github.com/new) and
follow GitHub's instructions to push this folder to it (it will show you the
exact `git remote add` / `git push` commands for your new repo).

### 2. Create the Render Web Service

1. Sign up / log in at [render.com](https://render.com).
2. Click **New +** → **Web Service**, and connect the GitHub repo you just
   pushed.
3. Set:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
4. Pick a paid instance type (required for the persistent disk in the next
   step).

### 3. Add a persistent disk

In the Web Service's **Disks** settings, add a disk — e.g. mount path `/data`,
size to taste (1GB is enough for a lot of photos; videos add up faster).

### 4. Set environment variables

In the service's **Environment** settings, add:

| Key | Value |
|---|---|
| `DATA_DIR` | `/data` (must match the disk's mount path from step 3) |
| `OWNER_KEY` | *(optional)* a private secret you make up — see below |

Render sets `PORT` automatically; you don't need to add it.

### 5. Deploy

Render will build and deploy automatically. It gives you a public URL like
`https://your-app-name.onrender.com` — that's what you share.

## Optional: owner override

Right now, whoever's name is on a photo (via the cookie set when they joined)
is the only one who can edit or delete it — there's no password, so identity
is just "whoever typed that name." That's fine for people you trust, but if
this goes public, you have no way to remove something a stranger uploads
under a name that isn't yours.

To fix that, set the `OWNER_KEY` environment variable to a private secret
only you know, then visit `https://your-app-url/owner?key=<that secret>`
once, on your own device. That unlocks permanent edit/delete rights over
*every* item, on that device, until you clear cookies. Don't share that URL —
anyone who has it gets full control.

Leave `OWNER_KEY` unset and this feature does nothing (the `/owner` page
404s).
