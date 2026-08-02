# Gallery

A simple photo/video gallery. Anyone with the link can view and add photos or
videos; joining lets you get credit for what you add and set a profile picture.

## How storage works

This app is built for [Vercel](https://vercel.com). Vercel runs it as a
serverless function with no persistent local disk, so nothing is stored on
disk:

- Photos, videos, and profile pictures upload **directly from the browser**
  to [Vercel Blob](https://vercel.com/docs/vercel-blob) storage.
- The gallery index and member list live in two small JSON files also stored
  in Blob (`data/metadata.json`, `data/members.json`), read and rewritten on
  each change.

This means the app needs a Blob store to do anything beyond showing an empty
gallery — see the deploy steps below.

## Deploying to Vercel

### 1. Import the project

1. Sign up / log in at [vercel.com](https://vercel.com) (signing in with your
   GitHub account is easiest — it links them automatically).
2. Click **Add New...** → **Project**, and import the
   [Cealisreal/austistically](https://github.com/Cealisreal/austistically)
   GitHub repo.
3. Vercel auto-detects this as a Node/Express app — no build settings to
   change. Click **Deploy**.

The first deploy will succeed, but the gallery page itself will show an error
until you complete step 2 (there's no Blob store connected yet).

### 2. Create a Blob store

1. In your new project's dashboard, open the **Storage** tab in the sidebar.
2. Select **Create Database** → **Blob**.
3. Set access to **Public** (this app has no passwords, so there's nothing
   to gain from Private storage, and Public keeps the code simpler).
4. Name it whatever you like and create it.
5. On the **Projects** tab of the store, connect it to this project, including
   the **Production**, **Preview**, and **Development** environments.

This automatically adds a `BLOB_READ_WRITE_TOKEN` environment variable (plus
some OIDC variables) to your project.

### 3. Redeploy

Environment variable changes don't apply to deploys that already happened.
Go to the project's **Deployments** tab and redeploy the latest one (or just
push a new commit) so the Blob connection takes effect.

Visit the URL Vercel gives you (`https://your-project.vercel.app`) — the
gallery should now load and accept uploads.

### 4. Optional: the owner override

Add one more environment variable in **Settings** → **Environment
Variables**:

| Key | Value |
|---|---|
| `OWNER_KEY` | a private secret you make up |

See [Optional: owner override](#optional-owner-override) below for what it
does. Redeploy after adding it, same as step 3.

## Running it locally

Because uploads and data live in Blob storage, plain `node server.js` only
half-works locally (pages load, but anything touching photos/members will
error) unless it can see your Blob credentials. Use the Vercel CLI instead,
which handles that automatically:

```bash
npm install -g vercel
vercel login
vercel link      # connects this folder to the Vercel project from step 1
vercel env pull  # downloads BLOB_READ_WRITE_TOKEN into .env.local
vercel dev       # runs the app locally with real Blob access
```

`vercel dev` also emulates the real Vercel Functions environment more
closely than plain `node server.js` does, so it's the more accurate way to
test changes before deploying.

`.env.local` contains a real secret — it's already excluded via
`.gitignore`, so don't remove that entry.

## Optional: owner override

Right now, whoever's name is on a photo (via the cookie set when they joined)
is the only one who can edit or delete it — there's no password, so identity
is just "whoever typed that name." That's fine for people you trust, but if
this goes public, you have no way to remove something a stranger uploads
under a name that isn't yours.

To fix that, set the `OWNER_KEY` environment variable to a private secret
only you know (see step 4 above), then visit
`https://your-project.vercel.app/owner?key=<that secret>` once, on your own
device. That unlocks permanent edit/delete rights over *every* item, on that
device, until you clear cookies. Don't share that URL — anyone who has it
gets full control.

Leave `OWNER_KEY` unset and this feature does nothing (the `/owner` page
404s).
