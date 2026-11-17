# Pickup Shop

One seller, many buyers. Buyers sign up with a phone number and password, add items to a cart, place an order,
pay by Mobile Money, then collect in person. No delivery.

## Run locally
    npm install
    export SELLER_PHONE=0241234567 SELLER_PASSWORD=your-password JWT_SECRET=$(openssl rand -hex 32)
    export MOMO_NUMBER=0241234567 MOMO_NAME="Your Name" SHOP_NAME="My Shop"
    npm start
Shop: http://localhost:3000  Seller dashboard: http://localhost:3000/seller.html

The seller account is created on first start from SELLER_PHONE and SELLER_PASSWORD.

## How it works
1. Seller adds items on the dashboard: upload a spreadsheet (download the template there), or add photos named after each SKU/name.
   Items without a photo get a coloured placeholder.
2. Buyer places an order. Stock is reserved immediately.
3. Buyer sends MoMo to the shop number with the order code as reference, then enters the transaction ID.
4. Seller sees the order, checks their MoMo, taps Confirm payment, then Ready for pickup, then Picked up.
   Cancelling an order returns its items to stock.

## Deploy
Any Node host works (Render, Railway, Fly.io, a VPS). Set the variables from `.env.example`, and set
`DATA_DIR` to a persistent disk, because the SQLite database and uploaded photos live there.
Serve over HTTPS and set `NODE_ENV=production`.

## Known limits
- Payments are confirmed manually by the seller; no gateway or automatic MoMo detection.
- No login rate limiting or password reset yet. Add `express-rate-limit` before going public.
- The `xlsx` package parses only files the seller uploads; do not expose that endpoint to others.
