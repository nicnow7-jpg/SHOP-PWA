# Pickup Shop

One seller, many buyers. Buyers sign up with a phone number and password, add items (choosing quantities) to a cart,
place an order, pay by Mobile Money, then collect in person. Buyers can see their order history and tap **Buy again**.
The seller manages items, orders, MoMo details and the **shop name** from `/seller.html`.

Stack: Installable PWA (works offline for browsing), Express on Vercel serverless functions, Postgres, plain HTML/JS.

## Why the first Vercel deploy failed (500 FUNCTION_INVOCATION_FAILED)
The first version used a SQLite file, saved photos to a local folder and called `app.listen()`. Vercel functions have no
permanent disk and no long-running server, so it crashed. This version keeps everything in a hosted Postgres database
(photos are stored in the database too) and exports the app as a serverless function.

## Deploy on GitHub + Vercel
1. Push this folder to a GitHub repository.
2. On vercel.com choose **Add New > Project**, import the repo, and keep the framework preset as **Other**.
3. Create the database: in the Vercel project open **Storage**, add **Neon (Postgres)** from the Marketplace and connect it
   to the project. This adds `DATABASE_URL` automatically (`POSTGRES_URL` also works).
4. Under **Settings > Environment Variables** add: `JWT_SECRET` (a long random string), `SELLER_PHONE`, `SELLER_PASSWORD`,
   `SHOP_NAME`, `MOMO_NUMBER`, `MOMO_NAME`, `PICKUP_ADDRESS`.
5. **Redeploy** (new variables apply only to new deployments).
6. Open `https://your-app.vercel.app/api/health`. You should see `{"ok":true}`. Then open `/` for the shop and
   `/seller.html` for the seller login.

Tables are created automatically on the first request. The seller account is created from `SELLER_PHONE` and
`SELLER_PASSWORD` the first time the app runs; changing those variables later does not change an existing seller account.

If a page shows an error message such as "DATABASE_URL is not set", that is the missing setup step. Full details of any
crash are in Vercel > your project > **Logs**.

## Installing it as an app (PWA)
- **Android (Chrome):** open the site and tap **Install app** in the header, or use the browser menu > Install app.
- **iPhone (Safari):** tap Share, then **Add to Home Screen**.
- **Computer (Chrome/Edge):** click the install icon in the address bar.
The installed app is named after the shop name set on the seller dashboard (the name is read when the app is installed).
Offline, buyers can still open the app and browse the last items they loaded and their cart; placing orders, logging in and
the seller dashboard need a connection. Login, order and seller data are never stored by the service worker.
PWAs require HTTPS, which Vercel provides. After you deploy a change to the app files, bump `V` in `public/sw.js`
(for example `pickup-shop-v2`) so phones pick up the new version.

## Run locally
    npm install
    cp .env.example .env     # fill in DATABASE_URL (any Postgres) and the other values
    npm run dev              # http://localhost:3000

## How it works
1. Seller adds items: upload a spreadsheet (a sample is downloadable on the Add items tab) and/or photos. Photos are
   shrunk in the browser, then matched to items by file name (SKU or item name). Items without a photo get a coloured
   placeholder.
2. Buyer places an order; stock is reserved immediately.
3. Buyer sends MoMo with the order code as reference and enters the transaction ID.
4. Seller confirms payment, marks Ready for pickup, then Picked up. Cancelling returns items to stock.

## Known limits
- Payment is confirmed manually by the seller; there is no payment gateway.
- No password reset or login rate limiting yet. Add rate limiting before going public.
- Vercel limits each request to about 4.5 MB, so spreadsheets must stay under that and photos are uploaded one at a time.
