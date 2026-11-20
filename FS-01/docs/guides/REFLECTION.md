# Individual reflection · Rout Adarsh Pradhan · FS-01 ShopSphere

[Index](../README.md) · [Reflection guide](REFLECTION_GUIDE.md) · [Presentation outline](PRESENTATION.md)

Submitted 20 November 2026 · live at https://shopsphere-fs01.vercel.app

## The project

ShopSphere is a multi-vendor marketplace: many stores sell, customers buy from several of them in one checkout, and the
platform splits each payment between the stores, keeps a commission, and holds each store's share until its order is
delivered. It's live, with the frontend on Vercel and the backend on AWS in Mumbai.

## Where I started

I was already comfortable with React, Node.js, Docker, databases and AWS. What was new for me was building a payment
flow where one payment is split between several sellers, and doing a full database migration on a live project.

## What I owned and decided

The backend is a Node.js and Express API written in TypeScript. The project started on MongoDB, but partway through, the
required tools changed to PostgreSQL with Prisma. That was a real challenge, because the whole data layer had to move
while the Express API kept working the same way. I did the migration on a separate branch, and only after all the tests
passed did I merge it into main. The live site switched over and kept working. I also set up the hosting myself: an
always-on AWS server, so nobody waits for a sleeping server, a free DuckDNS web address with HTTPS, the frontend on
Vercel, and UptimeRobot, which checks the site every 5 minutes and alerts me straight away if it goes down. I set up
Razorpay in test mode with its webhook, made test purchases to check every step, and chose the final look of the site.

## Working with AI help

I used an AI assistant throughout, mainly to plan the work and to build and run the tests. It helped me break the
project into steps I could finish on time, and I learned a lot from going through its plans and test results. The
decisions, the account and server setup, and checking that each step really worked were mine.

## The hardest parts

The migration was the hardest, because it's tricky to change the database under a working app without breaking
anything. The second was payments: in India, accepting real payments needs a registered business account, and
Razorpay's split-payment product isn't available without one. Razorpay's official documentation showed me how to use
test mode, so I built my own split-and-hold system on top of real test payments.

## What I learned

1. **Plan against the timeline, and fix problems as they come.** There will always be issues; what matters is taking
   them on and solving them.
2. **Go to the official documentation first.** When a tool or service isn't available in your region, the official
   docs usually show the alternative, as Razorpay's test mode did for me.
3. **Patience, and security from the start.** Keeping passwords and keys out of the code and watching what could cost
   money meant I never had security trouble or surprise bills.

## What I'd do next time

I'd put more focus on the UI/UX side: animations and interactions that show the user what's happening and make the
experience feel alive. There's a lot of room for ideas there, and I'd like my next project to explore it.
