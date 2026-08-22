🎟️ Solstice Events Kiosk Service (Async Pivot)
📖 Overview
This project implements a check‑in kiosk service for Solstice Events Co.’s tech conference.
It pivots from the vendor’s deprecated synchronous badge‑printing API to a new asynchronous message queue + webhook model.

Key Features
✅ Publish print requests to vendor’s queue instead of blocking REST calls

✅ Show “Pending Print…” until vendor confirms via webhook

✅ Update attendee status to “Checked In” only after confirmation

✅ Prevent duplicate badge printing (handles duplicate scans gracefully)

✅ Supports multiple kiosks when backed by Redis/Postgres

🛠 Tech Stack
Node.js + Express → Web server & API endpoints

RabbitMQ (amqplib) → Message queue for print requests

Redis/Postgres (optional) → Persistent attendee state tracking

Body‑Parser → JSON request parsing
