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

// --- Puppeteer booking function ---
async function bookViaWidget(venue, date, time, partySize, guest) {
  const b = await getBrowser();
  const page = await b.newPage();
  page.setDefaultTimeout(15000);

  try {
    // Parse date parts for the widget URL
    const [year, month, day] = date.split("-");

    // Step 1: Navigate to the SevenRooms reservation search page with params
    const searchUrl =
      `https://www.sevenrooms.com/explore/${venue.url_key}/reservations/create/search` +
      `?date=${month}-${day}-${year}` +
      `&party_size=${partySize}` +
      `&time_slot=${encodeURIComponent(time)}`;

    console.log(`[book] Navigating to: ${searchUrl}`);
    await page.goto(searchUrl, { waitUntil: "networkidle2", timeout: 20000 });

    // Step 2: Wait for the page to fully load (SPA)
    await new Promise((r) => setTimeout(r, 3000));

    // Wait for any clickable time slot element to appear
    await page.waitForFunction(
      () => {
        // Look for buttons/links containing time patterns like "2:00 PM" or "14:00"
        const allButtons = document.querySelectorAll("button, a, [role='button'], div[class*='time'], div[class*='slot']");
        return allButtons.length > 5;
      },
      { timeout: 12000 }
    );

    await new Promise((r) => setTimeout(r, 1000));

    // Find and click the time slot button matching our time
    const slotClicked = await page.evaluate((targetTime) => {
      const [h, m] = targetTime.split(":");
      const hour = parseInt(h);
      const ampm = hour >= 12 ? "PM" : "AM";
      const displayHour = hour > 12 ? hour - 12 : hour === 0 ? 12 : hour;
      const displayTime12 = `${displayHour}:${m} ${ampm}`;
      const displayTimeLower = displayTime12.toLowerCase();

      // Search through all interactive elements
      const candidates = document.querySelectorAll("button, a, [role='button'], div[tabindex], span[tabindex]");
      const debugTexts = [];

      for (const el of candidates) {
        const text = el.textContent.trim().toLowerCase();
        if (text.length > 0 && text.length < 30) debugTexts.push(text);

        if (
          text.includes(displayTimeLower) ||
          text.includes(displayTime12.toLowerCase().replace(" ", "")) ||
          text === targetTime ||
          text.includes(targetTime)
        ) {
          el.click();
          return { found: true, clicked: el.textContent.trim() };
        }
      }

      // Also try all elements containing the time
      const allEls = document.querySelectorAll("*");
      for (const el of allEls) {
        if (el.children.length > 0) continue; // Only leaf nodes
        const text = el.textContent.trim().toLowerCase();
        if (
          (text.includes(displayTimeLower) || text.includes(targetTime)) &&
          text.length < 30
        ) {
          // Click the closest clickable parent
          const clickable = el.closest("button, a, [role='button'], div[tabindex]") || el;
          clickable.click();
          return { found: true, clicked: el.textContent.trim() };
        }
      }

      return {
        found: false,
        available: debugTexts.filter((t) => /\d{1,2}[:\s]?\d{2}/.test(t)).slice(0, 15),
        allDebug: debugTexts.slice(0, 20),
      };
    }, time);

    if (!slotClicked.found) {
      console.log("[book] Slot not found. Available:", slotClicked.available);
      return {
        success: false,
        error: `Time slot ${time} not found on page`,
        available: slotClicked.available,
      };
    }
    console.log(`[book] Clicked slot: ${slotClicked.clicked}`);

    // Step 3: Wait for the guest details form to appear
    await new Promise((r) => setTimeout(r, 2000));
    await page.waitForFunction(
      () => document.querySelectorAll('input[type="text"], input[type="email"], input[type="tel"]').length >= 2,
      { timeout: 12000 }
    );
    await new Promise((r) => setTimeout(r, 500));

    // Step 4: Fill in guest details
    // Try various selectors for each field
    async function fillField(selectors, value) {
      for (const sel of selectors) {
        try {
          const el = await page.$(sel);
          if (el) {
            await el.click({ clickCount: 3 });
            await el.type(value, { delay: 30 });
            return true;
          }
        } catch (e) {}
      }
      return false;
    }

    await fillField(
      ['input[data-test="first_name"]', 'input[name="first_name"]', 'input[placeholder*="First"]', 'input[id*="first"]'],
      guest.first_name
    );

    await fillField(
      ['input[data-test="last_name"]', 'input[name="last_name"]', 'input[placeholder*="Last"]', 'input[id*="last"]'],
      guest.last_name
    );

    await fillField(
      ['input[data-test="email"]', 'input[name="email"]', 'input[type="email"]', 'input[placeholder*="Email"]'],
      guest.email || ""
    );

    // Phone number - handle dial code input separately if present
    const phoneNum = guest.phone.replace(/^\+44/, "").replace(/^44/, "").replace(/^0/, "");
    await fillField(
      ['input[data-test="phone_number"]', 'input[name="phone_number"]', 'input[type="tel"]', 'input[placeholder*="Phone"]'],
      phoneNum
    );

    await new Promise((r) => setTimeout(r, 300));

    // Step 5: Accept terms/policy if present
    try {
      const checkbox = await page.$('input[type="checkbox"][data-test="agreement"], input[type="checkbox"][name*="agree"], input[type="checkbox"][name*="policy"]');
      if (checkbox) {
        await checkbox.click();
        await new Promise((r) => setTimeout(r, 200));
      }
    } catch (e) {}

    // Step 6: Click the "Complete Reservation" / "Book" button
    const bookBtnClicked = await page.evaluate(() => {
      const buttons = document.querySelectorAll("button");
      for (const btn of buttons) {
        const text = btn.textContent.toLowerCase().trim();
        if (
          text.includes("complete reservation") ||
          text.includes("confirm reservation") ||
          text.includes("book now") ||
          text.includes("reserve")
        ) {
          btn.click();
          return { found: true, text: btn.textContent.trim() };
        }
      }
      // Try submit buttons
      const submits = document.querySelectorAll('button[type="submit"]');
      if (submits.length > 0) {
        submits[submits.length - 1].click();
        return { found: true, text: submits[submits.length - 1].textContent.trim() };
      }
      return { found: false };
    });

    if (!bookBtnClicked.found) {
      console.log("[book] Could not find book/submit button");
      return { success: false, error: "Could not find reservation submit button" };
    }
    console.log(`[book] Clicked: ${bookBtnClicked.text}`);

    // Step 7: Wait for confirmation
    await new Promise((r) => setTimeout(r, 3000));

    // Check for confirmation number or success indication
    const result = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // Look for confirmation number
      const confMatch = bodyText.match(
        /confirmation[:\s#]*([A-Z0-9]{4,})/i
      );

      // Check for success indicators
      const isSuccess =
        bodyText.toLowerCase().includes("confirmed") ||
        bodyText.toLowerCase().includes("reservation has been") ||
        bodyText.toLowerCase().includes("thank you") ||
        bodyText.toLowerCase().includes("we look forward") ||
        bodyText.toLowerCase().includes("booked");

      // Check for errors
      const isError =
        bodyText.toLowerCase().includes("sorry") ||
        bodyText.toLowerCase().includes("error") ||
        bodyText.toLowerCase().includes("unable to") ||
        bodyText.toLowerCase().includes("no longer available");

      return {
        confirmation_num: confMatch ? confMatch[1] : null,
        is_success: isSuccess,
        is_error: isError,
        page_snippet: bodyText.substring(0, 500),
      };
    });

    if (result.is_error && !result.is_success) {
      console.log("[book] Error on page:", result.page_snippet);
      return {
        success: false,
        error: "Booking was not confirmed by SevenRooms",
        detail: result.page_snippet.substring(0, 200),
      };
    }

    console.log("[book] Booking result:", {
      confirmation: result.confirmation_num,
      success: result.is_success,
    });

    return {
      success: true,
      confirmation_num: result.confirmation_num,
      page_confirmed: result.is_success,
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
      reservation_id: "res_" + Date.now(),
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
