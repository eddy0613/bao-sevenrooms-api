const express = require("express");
const fetch = require("node-fetch");

const app = express();
app.use(express.json());

const API_KEY = process.env.API_KEY || "bao_api_key_2026_secure_token_x9k2m";
const PORT = process.env.PORT || 3000;

const VENUES = {
  "bao-soho": {
    id: "bao-soho",
    url_key: "BAOSoho",
    name: "BAO Soho",
    city: "London",
    address: "53 Lexington Street, London, W1F 9AS",
  },
  "bao-marylebone": {
    id: "bao-marylebone",
    url_key: "baomary",
    name: "BAO Marylebone",
    city: "London",
    address: "56 James Street, Marylebone, London, W1U 1HF",
  },
  "bao-borough": {
    id: "bao-borough",
    url_key: "baoborough",
    name: "BAO Borough",
    city: "London",
    address: "13 Stoney Street, Borough Market, London, SE1 9AD",
  },
  "bao-kings-cross": {
    id: "bao-kings-cross",
    url_key: "baokingscross",
    name: "BAO King's Cross",
    city: "London",
    address: "4 Pancras Square, King's Cross, London, N1C 4AG",
  },
  "bao-city": {
    id: "bao-city",
    url_key: "baocity",
    name: "BAO City",
    city: "London",
    address: "2-8 Bloomberg Arcade, London, EC4N 8AR",
  },
  "bao-shoreditch": {
    id: "bao-shoreditch",
    url_key: "baonoodleshop",
    name: "BAO Shoreditch",
    city: "London",
    address: "1 Redchurch Street, Shoreditch, London, E2 7DJ",
  },
  "bao-battersea": {
    id: "bao-battersea",
    url_key: "baobattersea",
    name: "BAO Battersea",
    city: "London",
    address:
      "Level 1, Turbine Hall A, Battersea Power Station, London, SW11 8DD",
  },
};

// Also accept the variant attribute venue_ids as aliases
const VENUE_ALIASES = {
  BAOSoho: "bao-soho",
  baomary: "bao-marylebone",
  baoborough: "bao-borough",
  baokingscross: "bao-kings-cross",
  baocity: "bao-city",
  baonoodleshop: "bao-shoreditch",
  baobattersea: "bao-battersea",
};

function resolveVenue(venueInput) {
  if (VENUES[venueInput]) return VENUES[venueInput];
  const aliased = VENUE_ALIASES[venueInput];
  if (aliased && VENUES[aliased]) return VENUES[aliased];
  return null;
}

// Auth middleware
function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// GET /health
app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

// GET /venues
app.get("/venues", auth, (_req, res) => {
  const venues = Object.values(VENUES).map(({ id, name, city, address }) => ({
    id,
    name,
    city,
    address,
  }));
  res.json({ venues });
});

// POST /check-availability
app.post("/check-availability", auth, async (req, res) => {
  const { venue: venueInput, date, party_size, time } = req.body;

  if (!venueInput || !date || !party_size) {
    return res
      .status(400)
      .json({ error: "Missing required fields: venue, date, party_size" });
  }

  const venue = resolveVenue(venueInput);
  if (!venue) {
    return res.status(400).json({
      error: `Unknown venue "${venueInput}"`,
      available_venues: Object.keys(VENUES),
    });
  }

  try {
    const params = new URLSearchParams({
      venue: venue.url_key,
      party_size: String(party_size),
      halo_size_interval: "16",
      start_date: date,
      num_days: "1",
      channel: "SEVENROOMS_WIDGET",
    });
    if (time) params.set("time_slot", time);

    const url = `https://www.sevenrooms.com/api-yoa/availability/widget/range?${params}`;
    const srRes = await fetch(url, {
      headers: { Accept: "application/json" },
      timeout: 5000,
    });
    const srData = await srRes.json();

    if (srData.status !== 200 || !srData.data) {
      return res
        .status(502)
        .json({ error: "SevenRooms API error", detail: srData.msg });
    }

    const dayData = srData.data.availability?.[date];
    if (!dayData || dayData.length === 0) {
      return res.status(409).json({
        error: "No availability",
        available_times: [],
        date,
        party_size,
        venue_name: venue.name,
      });
    }

    // Flatten all time slots from all shifts
    const allSlots = [];
    for (const shift of dayData) {
      if (shift.is_closed) continue;
      for (const slot of shift.times || []) {
        if (slot.type !== "book") continue;
        allSlots.push({
          time: slot.time,
          time_iso: slot.time_iso,
          access_persistent_id: slot.access_persistent_id,
          shift_persistent_id: slot.shift_persistent_id,
          shift_name: shift.name,
        });
      }
    }

    if (allSlots.length === 0) {
      return res.status(409).json({
        error: "No availability",
        available_times: [],
        date,
        party_size,
        venue_name: venue.name,
      });
    }

    res.json({
      available_times: allSlots,
      date,
      party_size,
      venue_name: venue.name,
      message: `${allSlots.length} slot(s) available`,
    });
  } catch (err) {
    console.error("check-availability error:", err);
    res.status(502).json({ error: "Failed to reach SevenRooms" });
  }
});

// POST /book
app.post("/book", auth, async (req, res) => {
  const {
    venue: venueInput,
    date,
    time,
    party_size,
    first_name,
    last_name,
    email,
    phone,
    phone_dial_code = "44",
    phone_country_code = "GB",
  } = req.body;

  if (
    !venueInput ||
    !date ||
    !time ||
    !party_size ||
    !first_name ||
    !last_name ||
    !phone
  ) {
    return res.status(400).json({
      error:
        "Missing required fields: venue, date, time, party_size, first_name, last_name, phone",
    });
  }

  const venue = resolveVenue(venueInput);
  if (!venue) {
    return res.status(400).json({
      error: `Unknown venue "${venueInput}"`,
      available_venues: Object.keys(VENUES),
    });
  }

  try {
    // Use provided IDs if available, otherwise fetch from SevenRooms
    let accessPersistentId = req.body.access_persistent_id;
    let shiftPersistentId = req.body.shift_persistent_id;

    if (!accessPersistentId || !shiftPersistentId) {
      // Step 1: Get availability to find the slot IDs
      const availParams = new URLSearchParams({
        venue: venue.url_key,
        party_size: String(party_size),
        halo_size_interval: "16",
        start_date: date,
        num_days: "1",
        channel: "SEVENROOMS_WIDGET",
        time_slot: time,
      });

      const availUrl = `https://www.sevenrooms.com/api-yoa/availability/widget/range?${availParams}`;
      const availRes = await fetch(availUrl, {
        headers: { Accept: "application/json" },
        timeout: 5000,
      });
      const availData = await availRes.json();

      if (availData.status !== 200 || !availData.data) {
        return res
          .status(502)
          .json({ error: "Could not verify availability", detail: availData.msg });
      }

      // Find the matching time slot
      const dayData = availData.data.availability?.[date] || [];
      let matchingSlot = null;
      for (const shift of dayData) {
        if (shift.is_closed) continue;
        for (const slot of shift.times || []) {
          if (slot.time === time && slot.type === "book") {
            matchingSlot = slot;
            break;
          }
        }
        if (matchingSlot) break;
      }

      accessPersistentId = matchingSlot?.access_persistent_id;
      shiftPersistentId = matchingSlot?.shift_persistent_id;
    }

    if (!accessPersistentId || !shiftPersistentId) {
      return res
        .status(409)
        .json({ error: "Time slot no longer available", date, time });
    }

    // Step 2: Create a hold (lock the slot)
    const holdBody = {
      venue: venue.url_key,
      date,
      party_size: parseInt(party_size),
      shift_persistent_id: shiftPersistentId,
      time_slot: time,
      access_persistent_id: accessPersistentId,
      halo_size_interval: 16,
    };

    const holdRes = await fetch(
      "https://www.sevenrooms.com/api-yoa/availability/widget/hold",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(holdBody),
        timeout: 5000,
      }
    );
    const holdData = await holdRes.json();

    if (holdData.status !== 200) {
      return res.status(409).json({
        error: "Could not hold time slot",
        detail: holdData.msg,
      });
    }

    const holdId = holdData.data?.hold_id;
    const holdToken = holdData.data?.token;

    // Step 3: Submit the booking
    const bookBody = {
      venue: venue.url_key,
      date,
      time_slot: time,
      party_size: parseInt(party_size),
      first_name,
      last_name,
      email: email || "",
      phone_number: phone.replace(/^\+/, ""),
      phone_dial_code: phone_dial_code,
      phone_country_code: phone_country_code,
      shift_persistent_id: shiftPersistentId,
      access_persistent_id: accessPersistentId,
      hold_id: holdId,
      token: holdToken,
      halo_size_interval: 16,
      venue_marketing_opt_in: false,
      sevenrooms_marketing_opt_in: false,
      notes: "",
      channel: "SEVENROOMS_WIDGET",
    };

    const bookRes = await fetch(
      "https://www.sevenrooms.com/api-yoa/book/widget",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify(bookBody),
        timeout: 10000,
      }
    );
    const bookData = await bookRes.json();

    if (bookData.status !== 200) {
      return res.status(400).json({
        error: "Booking failed",
        detail: bookData.msg,
      });
    }

    const reservation = bookData.data;
    res.json({
      success: true,
      confirmation_num: reservation?.confirmation_number || null,
      reservation_id: reservation?.id || null,
      date,
      time,
      party_size,
      venue_name: venue.name,
      first_name,
      last_name,
    });
  } catch (err) {
    console.error("book error:", err);
    res.status(502).json({ error: "Failed to complete booking" });
  }
});

// Landing page
app.get("/", (_req, res) => {
  res.json({
    name: "BAO SevenRooms Booking API",
    version: "1.0.0",
    venues: Object.keys(VENUES).length,
    endpoints: ["GET /health", "GET /venues", "POST /check-availability", "POST /book"],
  });
});

app.listen(PORT, () => {
  console.log(`BAO SevenRooms API running on port ${PORT}`);
});
