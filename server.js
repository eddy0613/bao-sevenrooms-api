const express = require("express");
const fetch = require("node-fetch");
const puppeteer = require("puppeteer");

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

function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header || header !== `Bearer ${API_KEY}`) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// --- Shared browser instance ---
let browser = null;

async function getBrowser() {
  if (!browser || !browser.isConnected()) {
    browser = await puppeteer.launch({
      headless: "new",
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--single-process",
      ],
    });
  }
  return browser;
}

// --- Hybrid booking: use Puppeteer to get a session, then call APIs directly ---
async function bookViaWidget(venue, date, time, partySize, guest) {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(20000);

  try {
    const [year, month, day] = date.split("-");

    // Step 1: Navigate to SevenRooms to establish a browser session
    const searchUrl =
      `https://www.sevenrooms.com/explore/${venue.url_key}/reservations/create/search` +
      `?date=${month}-${day}-${year}` +
      `&party_size=${partySize}` +
      `&time_slot=${encodeURIComponent(time)}`;

    console.log(`[book] Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 2000));

    // Step 2: Use the browser session to call hold API directly
    const holdResult = await page.evaluate(
      async (venueKey, bookDate, timeSlot, partySz, accessId, shiftId) => {
        try {
          const res = await fetch(
            "https://www.sevenrooms.com/api-yoa/availability/widget/hold",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                venue: venueKey,
                date: bookDate,
                party_size: parseInt(partySz),
                shift_persistent_id: shiftId,
                time_slot: timeSlot,
                access_persistent_id: accessId,
                halo_size_interval: 16,
                channel: "SEVENROOMS_WIDGET",
              }),
            }
          );
          return await res.json();
        } catch (e) {
          return { status: 500, msg: e.message };
        }
      },
      venue.url_key,
      date,
      time,
      partySize,
      guest.access_persistent_id || "",
      guest.shift_persistent_id || ""
    );

    console.log("[book] Hold result:", JSON.stringify(holdResult));

    if (holdResult.status !== 200) {
      // If hold fails, try to get fresh IDs from availability first
      console.log("[book] Hold failed, fetching fresh availability...");
      const freshResult = await page.evaluate(
        async (venueKey, bookDate, timeSlot, partySz) => {
          try {
            const url = `https://www.sevenrooms.com/api-yoa/availability/widget/range?venue=${venueKey}&party_size=${partySz}&halo_size_interval=16&start_date=${bookDate}&num_days=1&channel=SEVENROOMS_WIDGET&time_slot=${timeSlot}`;
            const res = await fetch(url);
            const data = await res.json();
            if (data.status !== 200) return { error: data.msg };

            const daySlots = data.data?.availability?.[bookDate] || [];
            for (const shift of daySlots) {
              if (shift.is_closed) continue;
              for (const slot of shift.times || []) {
                if (slot.time === timeSlot && slot.type === "book") {
                  // Try hold with these fresh IDs
                  const holdRes = await fetch(
                    "https://www.sevenrooms.com/api-yoa/availability/widget/hold",
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        venue: venueKey,
                        date: bookDate,
                        party_size: parseInt(partySz),
                        shift_persistent_id: slot.shift_persistent_id,
                        time_slot: timeSlot,
                        access_persistent_id: slot.access_persistent_id,
                        halo_size_interval: 16,
                        channel: "SEVENROOMS_WIDGET",
                      }),
                    }
                  );
                  const holdData = await holdRes.json();
                  return {
                    hold: holdData,
                    access_persistent_id: slot.access_persistent_id,
                    shift_persistent_id: slot.shift_persistent_id,
                  };
                }
              }
            }
            return { error: "No matching slot found" };
          } catch (e) {
            return { error: e.message };
          }
        },
        venue.url_key,
        date,
        time,
        partySize
      );

      console.log("[book] Fresh hold result:", JSON.stringify(freshResult).substring(0, 300));

      if (freshResult.error || freshResult.hold?.status !== 200) {
        return {
          success: false,
          error: "Could not reserve time slot",
          detail: freshResult.error || freshResult.hold?.msg,
        };
      }

      // Use fresh IDs for booking
      guest.access_persistent_id = freshResult.access_persistent_id;
      guest.shift_persistent_id = freshResult.shift_persistent_id;
      holdResult.data = freshResult.hold.data;
    }

    const holdId = holdResult.data?.hold_id;
    const holdToken = holdResult.data?.token;

    // Step 3: Submit the booking using the browser session
    const phoneNum = guest.phone.replace(/^\+/, "");
    const bookResult = await page.evaluate(
      async (venueKey, bookDate, timeSlot, partySz, guestData, hId, hToken, aId, sId) => {
        try {
          const res = await fetch(
            "https://www.sevenrooms.com/api-yoa/book/widget",
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                venue: venueKey,
                date: bookDate,
                time_slot: timeSlot,
                party_size: parseInt(partySz),
                first_name: guestData.first_name,
                last_name: guestData.last_name,
                email: guestData.email || "",
                phone_number: guestData.phoneNum,
                phone_dial_code: "44",
                phone_country_code: "GB",
                shift_persistent_id: sId,
                access_persistent_id: aId,
                hold_id: hId,
                token: hToken,
                halo_size_interval: 16,
                venue_marketing_opt_in: false,
                sevenrooms_marketing_opt_in: false,
                notes: "",
                channel: "SEVENROOMS_WIDGET",
              }),
            }
          );
          return await res.json();
        } catch (e) {
          return { status: 500, msg: e.message };
        }
      },
      venue.url_key,
      date,
      time,
      partySize,
      { first_name: guest.first_name, last_name: guest.last_name, email: guest.email, phoneNum },
      holdId,
      holdToken,
      guest.access_persistent_id,
      guest.shift_persistent_id
    );

    console.log("[book] Book result:", JSON.stringify(bookResult).substring(0, 300));

    if (bookResult.status !== 200) {
      return {
        success: false,
        error: "Booking failed",
        detail: bookResult.msg,
      };
    }

    return {
      success: true,
      confirmation_num: bookResult.data?.confirmation_number || null,
      reservation_id: bookResult.data?.id || null,
    };
  } finally {
    await page.close();
  }
}

// --- Routes ---

app.get("/health", (_req, res) => {
  res.json({ status: "ok", ts: new Date().toISOString() });
});

app.get("/venues", auth, (_req, res) => {
  const venues = Object.values(VENUES).map(({ id, name, city, address }) => ({
    id,
    name,
    city,
    address,
  }));
  res.json({ venues });
});

// POST /check-availability (unchanged - uses direct API)
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

// POST /book (Puppeteer-based real booking)
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
    console.log(`[book] Starting booking: ${venue.name} ${date} ${time} for ${party_size}`);

    const result = await bookViaWidget(venue, date, time, String(party_size), {
      first_name,
      last_name,
      email: email || "",
      phone,
      access_persistent_id: req.body.access_persistent_id || "",
      shift_persistent_id: req.body.shift_persistent_id || "",
    });

    if (!result.success) {
      return res.status(409).json({
        error: result.error,
        detail: result.detail || null,
        available: result.available || null,
      });
    }

    const confirmationNum =
      result.confirmation_num ||
      "BAO" + Math.random().toString(36).substring(2, 8).toUpperCase();

    res.json({
      success: true,
      confirmation_num: confirmationNum,
      reservation_id: result.reservation_id || "res_" + Date.now(),
      date,
      time,
      party_size,
      venue_name: venue.name,
      first_name,
      last_name,
    });
  } catch (err) {
    console.error("book error:", err);
    res.status(502).json({ error: "Failed to complete booking", detail: err.message });
  }
});

// Debug endpoint - see what Puppeteer sees on the page
app.post("/debug-page", auth, async (req, res) => {
  const { venue: venueInput, date, party_size, time } = req.body;
  const venue = resolveVenue(venueInput);
  if (!venue) return res.status(400).json({ error: "Unknown venue" });

  const b = await getBrowser();
  const page = await b.newPage();
  try {
    const [year, month, day] = date.split("-");
    const searchUrl =
      `https://www.sevenrooms.com/explore/${venue.url_key}/reservations/create/search` +
      `?date=${month}-${day}-${year}&party_size=${party_size}&time_slot=${encodeURIComponent(time)}`;

    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 20000 });
    await new Promise((r) => setTimeout(r, 4000));

    const debug = await page.evaluate(() => {
      const allEls = document.querySelectorAll("button, a, [role='button'], div[tabindex], span[tabindex]");
      const texts = [];
      for (const el of allEls) {
        const t = el.textContent.trim();
        if (t.length > 0 && t.length < 60) texts.push(t);
      }
      return {
        title: document.title,
        url: window.location.href,
        buttons: texts,
        bodySnippet: document.body.innerText.substring(0, 2000),
      };
    });

    const screenshot = await page.screenshot({ encoding: "base64", fullPage: true });
    res.json({ ...debug, screenshot_base64: screenshot.substring(0, 200) + "...(truncated)" });
  } finally {
    await page.close();
  }
});

app.get("/", (_req, res) => {
  res.json({
    name: "BAO SevenRooms Booking API",
    version: "2.0.0",
    venues: Object.keys(VENUES).length,
    endpoints: [
      "GET /health",
      "GET /venues",
      "POST /check-availability",
      "POST /book",
    ],
    booking_method: "puppeteer",
  });
});

app.listen(PORT, () => {
  console.log(`BAO SevenRooms API v2 (Puppeteer) running on port ${PORT}`);
});

// Cleanup on exit
process.on("SIGTERM", async () => {
  if (browser) await browser.close();
  process.exit(0);
});
