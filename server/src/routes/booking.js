/* =========================================================
   Magzest server — public booking availability
   GET /api/booking/availability → free IST slots per day,
   used by the "Book a call" modal's slot picker.
   ========================================================= */

import express from "express";
import { availability } from "../booking.js";

export const bookingRouter = express.Router();

bookingRouter.get("/booking/availability", (req, res) => {
  res.set("Cache-Control", "no-store").json({ ok: true, ...availability() });
});
