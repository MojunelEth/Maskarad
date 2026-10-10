# Masquerade

A free website for AI character videos. A person uploads a short video, and the AI replaces them with a fictional character with an AI face. The moves, expressions, sound and background stay from the original video.

The site doesn’t accept money. Every user connects their own fal.ai key, and the AI charges their fal.ai balance: about $1.20 per video up to 10 seconds and about $0.08 per custom character. The site owner only pays for hosting.

## Four tabs

1. **AI video** (`/`). This is where videos are made: upload a clip, pick a character, click “Create video”. There are seven ready-made characters (Lavinia, Barry Breeze, Nigel Sprout, Glenda Foyle, Horace Steeple, Winston Plank and Grandpa Mervyn) and a “Your own character” card: the user describes a look in words, and the AI draws a new face. The arrows on a character’s card open their character sheet, the full outfit from every side (for characters that have one). For a newcomer, the button opens sign-up and then the “Connect the AI” window. After that, the video starts automatically.
2. **Guide** (`/guide`). How to connect the AI and run an AI character page: create a character, film yourself, make a video, build a series, post, watch the right numbers and earn. It’s written in short paragraphs, step-by-step lists and tables (costs, character formula, filming do’s and don’ts, metrics, earning options, troubleshooting). Ready scenes and captions for each character are at the bottom.
3. **Account** (`/account`). The fal.ai key (connect, replace, remove), my videos (watch, download, report a problem), my characters, password change.
4. **Help** (`/help`). Answers to common questions and a contact form. Messages arrive in the admin panel.

There’s also an admin panel (`/admin`) and the Rules and Privacy pages.

## How it works

1. A person signs up with an email and a password.
2. The site shows the “Connect the AI” window with buttons to fal.ai: sign up, add credit, create a key. The person pastes the key; the site checks it on fal.ai without spending anything and stores it encrypted.
3. The person picks a character and uploads a video. The server trims the video to 10 seconds and separates the sound. The model only makes 9:16 or 16:9 videos and crops any other shape, so the server places the whole picture inside a 9:16 (or 16:9) frame itself and cuts the margins off afterwards: nothing at the edges, like a waving hand, gets lost.
4. The video and the character’s photo go to the [Wan 2.2 Animate Replace](https://fal.ai/models/fal-ai/wan/v2.2-14b/animate/replace) model on fal.ai, on behalf of that person’s key.
5. The finished video gets the original sound back, with no watermark, and stays in the account for a day.

Ready-made characters come with their pictures: a card and, for some, a second expression shown on hover and a character sheet. For the AI, each one also needs a clean HD reference photo. It’s prepared once from the character’s pictures with the image model (fal-ai/nano-banana-2/edit) and then shared with everyone: before the first video with that character, using the key of whoever picked it (about $0.08; the site warns about this). If you want all seven photos prepared right away at your expense (about $0.56, one time), set your own `FAL_KEY`, or simply make the first video with each character yourself. If preparing fails for a reason other than the key or the balance, the video still goes ahead with the card picture.

If a user’s fal.ai balance runs out or their key is revoked, the site says so and offers a “Top up fal.ai” or “Connect key” button.

Accounts, keys and support messages are stored in SQLite, which is built into Node.js. The project has no external npm dependencies: it only needs Node.js 22.13+ and ffmpeg. The Docker image includes both.

## What it costs the owner

Only hosting. On Render, that’s the Starter plan with a 5 GB persistent disk: about $7 for the server and about $1.25 for the disk per month. Without a persistent disk, accounts and keys would disappear on every restart, so the free plan won’t work.

No Stripe, crypto wallet or business details are needed: no money passes through the site.

## Launch

**1. GitHub.** Create a private repository. On its page, click “uploading an existing file” and drag in everything inside the `maskarad` folder (not the folder itself): `render.yaml` must be at the root. Click Commit changes.

**2. Render.** On [dashboard.render.com](https://dashboard.render.com), click New → Blueprint, connect GitHub and choose the repository. Render shows the `OWNER_NAME` and `OWNER_EMAIL` fields: enter your name and a contact email for users, or leave them empty. Click Deploy Blueprint and add a card to pay for Render. In 5–10 minutes the site opens at an address like `https://maskarad.onrender.com`.

**3. Admin panel.** In the service’s Environment section, copy the `ADMIN_TOKEN` value (Render generated it) and sign in with it at `https://your-site/admin`.

**4. Check.** Sign up on your site as a regular user, connect your own fal.ai key and make a test video.

## How to update the site

Upload the new files to the same repository: Add file → Upload files → drag in everything inside the folder → Commit changes. GitHub replaces the old files, and Render rebuilds the site by itself in 2–5 minutes. Users’ accounts, keys and videos stay: they live on Render’s disk, not on GitHub.

While Render switches versions, the site shows a 502 error for 1–3 minutes. That’s normal for a service with a persistent disk: Render stops the old version before starting the new one.

GitHub’s upload doesn’t delete files that are gone from the new version. If a file is no longer needed, open it on GitHub, choose Delete file in the ⋯ menu and click Commit changes. Files left over from older versions that can be deleted: `public/characters/bruno.jpg`, `public/characters/bruno-source.jpg`, `public/characters/darlene.jpg`, `public/characters/darlene-source.jpg`, `assets/watermark.png`, `assets/illustrations/*.png`, `public/characters/*.svg`, `src/payments.js`, `src/stripe.js`, `src/nowpayments.js`, `public/paid.html`, `public/paid.js`, `legal/refunds.html`, `scripts/payments-test.js`.

## Admin panel

The `/admin` page, signed in with `ADMIN_TOKEN`. It shows:
- how many accounts there are, how many have connected a key, how many videos are done and how many failed;
- messages from the Help tab: reply by email and close;
- user search by email: whether a key is connected (only the last 4 characters are visible), video history, and a temporary password for users who forgot theirs.

The site doesn’t send emails. If a user forgets their password, they write in Help, you issue a temporary password in the admin panel and reply to them by email. Their fal.ai key stays connected.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `ADMIN_TOKEN` | — | Password for `/admin`. Empty means the admin panel is off |
| `OWNER_NAME`, `OWNER_EMAIL` | — | Who runs the site and how to reach them. Shown in the Rules and on the Help tab |
| `FAL_KEY` | — | Optional owner key: ready-made characters’ HD reference photos are prepared at startup at the owner’s expense |
| `PROVIDER` | `fal` | `mock` is a demo without the AI: a picture is placed over the video and keys aren’t checked |
| `DB_PATH` | `data/maskarad.db` | The database. Must live on a persistent disk. A `key-secret` file appears next to it: it encrypts users’ keys |
| `KEY_SECRET` | — | Your own encryption secret instead of the `key-secret` file. If you change it, users will have to paste their keys again |
| `DATA_DIR` | `data/work` | Finished videos and temporary files |
| `PHOTOS_DIR` | `data/characters` | Character photos, including the ones users drew |
| `KEEP_RESULTS_MINUTES` | `1440` | How many minutes finished videos stay in accounts |
| `SESSION_DAYS` | `30` | How many days a sign-in lasts |
| `MAX_CUSTOM_CHARACTERS` | `6` | How many custom characters an account can keep |
| `CHARACTER_GENERATIONS_PER_DAY` | `10` | How many custom characters a user can draw per day |
| `MODEL` | `wan` | `wan` or `pixverse` |
| `RESOLUTION` | `720p` | wan: `480p`, `580p`, `720p`; pixverse: `360p`, `540p`, `720p`, `1080p` |
| `INPUT_FPS` | `24` | Frames per second sent to the model. At 16, videos cost users a third less |
| `INFERENCE_STEPS` | `30` | Denoising steps of the video model (4–50). More steps mean cleaner hands and faces and a longer wait; fal.ai charges by frames, so the price stays the same |
| `MAX_SECONDS` | `10` | How many seconds of video to use |
| `MAX_UPLOAD_MB` | `100` | Maximum file size |
| `MAX_ACTIVE_JOBS` | `10` | How many videos the site handles at once. Each user gets one video at a time |
| `MAX_FFMPEG` | `2` | How many videos the server trims and assembles at once |
| `PUBLIC_URL` | Render address | The site’s address if it isn’t hosted on Render |

Users’ prices are set by fal.ai. The site shows an estimate based on fal.ai’s rates as of early October 2026: Wan 720p at 24 fps costs about $0.12 per second of video.

## Ready-made characters

A character is an entry in `characters/characters.json` plus pictures in `public/characters`:

| File | What it is |
| --- | --- |
| `<id>.jpg` | The card: a 3:4 portrait close-up. Also used in demo mode and as a fallback reference |
| `<id>-alt.jpg` | Optional: a second expression, shown when the mouse is over the card |
| `<id>-sheet.jpg` | Optional, but recommended: the character sheet (views from every side and close-ups). The AI prepares the HD reference photo from it, and users can open it from the card |
| `<id>-source.jpg` | Optional, when there’s no sheet: a picture only the AI looks at when preparing the HD photo. Without it, the AI uses the card |

```json
{
  "id": "captain",
  "name": "Captain Splash",
  "tagline": "One line shown on the character card",
  "seed": 81234,
  "prompt": "the look in English: age, hair, outfit, one or two striking details",
  "gesture": "A signature gesture repeated in every video",
  "scenes": ["Scene 1", "Scene 2", "Scene 3"],
  "caption": "A caption for posting"
}
```

The `id` must match the file names. If the card is only a rough preview, add `"preview": true`: once the HD photo is ready, the card shows it instead. The scenes and caption appear on the Guide tab. Without a sheet, the HD reference is drawn from the `prompt` text alone. To redo a reference photo you don’t like: `FAL_KEY=… npm run characters -- --force captain`. You can also put your own photo in the `PHOTOS_DIR` folder as `<id>.png`: one person facing the camera on a plain background.

Only add characters you created yourself. Using the likeness of real people or other creators’ characters, including famous cartoon characters, isn’t allowed: it risks complaints, takedowns and bans on social media.

## Design

Dark studio look with one warm accent: the colors, fonts and spacing are variables at the top of `public/styles.css`. Fonts (Inter, Inter Display, Lora Italic) are stored in `public/fonts`, so the site loads nothing from other servers. The video area works like a camera viewfinder: a status label in the corner, a scanning line and a progress bar while the AI works.

## Safety

- Nobody can upload someone else’s face: custom characters are created from a text description only. The image model is told never to draw real people or celebrities, and the site itself rejects descriptions of children and explicit descriptions.
- fal.ai keys are stored encrypted (AES-256-GCM), never shown in full, never written to logs, and kept in server memory only while a video is being made. Users can remove their key on the site or revoke it on fal.ai.
- Custom characters, videos and history are visible only to the account owner.
- Before uploading, the user confirms that the video shows only them or people who agreed to it. The service is for people 18 and older.
- Videos have no visible watermark, but the file’s metadata notes that it was made with AI, and the guide asks users to turn on the platforms’ AI-content setting when posting. The model’s input and output safety checks are turned on.
- Passwords are stored only as hashes (scrypt), and sign-in is kept in an HttpOnly cookie. Requests from other websites are rejected, and repeated sign-in attempts and key checks are rate-limited.
- The original video is deleted right after processing, the finished one after a day.

## Running locally and tests

```bash
PROVIDER=mock npm start   # demo without the AI: http://localhost:3000
cp .env.example .env      # settings, then run with the real AI:
npm run dev
npm test                  # all checks, no internet and no money needed
```

`npm test` runs three sets of checks: the full path in demo mode (accounts, key, videos, custom characters, access rights, support messages), the fal.ai integration, and long-term account behavior (admin panel, restarts, migration from an older database). For fal.ai, the test starts a fake server that answers like the real API and accepts only its own keys. It checks that every user pays with their own key, that a key without credit gives a clear error, and that keys never reach the logs.

## If something doesn’t work

- **502 error right after an update.** Wait 1–3 minutes: Render is switching versions.
- **The site doesn’t open after changing settings or updating.** Open the Logs tab on Render: it says what’s wrong.
- **“fal.ai rejected your key”.** The user should create a new key on fal.ai (API scope) and paste it on the Account tab.
- **“Your fal.ai balance has run out”.** The user tops up their own fal.ai balance; the site has nothing to do with it.
- **All users lost their keys.** The `key-secret` file next to the database is gone or `KEY_SECRET` changed. The site will ask everyone to paste their key again.
- **Strange or blurry fingers.** Hands are the hardest part for any AI video model. The site already sends the whole frame and runs the model at 30 steps; the rest depends on the source video: bare hands kept inside the frame, smooth moves, good light and the original camera file rather than a video re-downloaded from TikTok. You can also try `INFERENCE_STEPS=40`.
- **The character doesn’t look right.** The best results come from one person in the frame, visible face and hands, a still camera and even light. Tips for users are on the Guide tab. If a ready-made character’s HD reference came out wrong, redo it with `npm run characters -- --force <id>`.
- **A user forgot their password.** Admin panel → User → “Issue a temporary password”, then reply to them by email.
