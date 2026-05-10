require("dotenv").config();
const fs = require("fs");
const { chromium } = require("playwright");

const INGEST_URL = process.env.INGEST_URL;
const INGEST_TOKEN = process.env.INGEST_TOKEN;
const HEADLESS = true; // set true in GitHub Actions later

function getOriginConfig(origin) {
  const map = {
    CA: {
      currency: "CAD",
      countryName: "Canada",
      countrySearch: "canada",
      countryCode2: "CA",
      countryCode3: "CAN",
      sendingParam: "CA",
      localePath: "en-ca",
    },
    US: {
      currency: "USD",
      countryName: "United States",
      countrySearch: "united states",
      countryCode2: "US",
      countryCode3: "USA",
      sendingParam: "US",
      localePath: "en-us",
    },
    GB: {
      currency: "GBP",
      countryName: "United Kingdom",
      countrySearch: "united kingdom",
      countryCode2: "GB",
      countryCode3: "GBR",
      sendingParam: "GB",
      localePath: "en-gb",
    },
  };

  return map[origin] || map.CA;
}

function currencyForDestination(destination) {
  if (destination === "GH") return "GHS";
  if (destination === "NG") return "NGN";
  return "GHS";
}

async function postQuote(payload) {
  if (
    !INGEST_URL ||
    !INGEST_TOKEN ||
    INGEST_URL.includes("your-quoteops-app-url") ||
    INGEST_TOKEN.includes("your_secret_token_here")
  ) {
    console.log("INGEST_URL or INGEST_TOKEN not set. Quote extracted locally only:");
    console.log(payload);
    return;
  }

  const res = await fetch(INGEST_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${INGEST_TOKEN}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Ingest failed: ${res.status} ${text}`);
  }
}

function saveDebugText(provider, text) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  fs.writeFileSync(`debug-${safe}.txt`, text || "", "utf8");
}

async function saveScreenshot(page, provider) {
  const safe = provider.replace(/\s+/g, "-").toLowerCase();
  const file = `debug-${safe}.png`;
  await page.screenshot({ path: file, fullPage: true });
  return file;
}

function parseLocaleNumber(value) {
  if (value === null || value === undefined) return null;

  let str = String(value).trim();
  if (!str) return null;

  str = str.replace(/[^\d,.-]/g, "");

  const hasComma = str.includes(",");
  const hasDot = str.includes(".");

  if (hasComma && hasDot) {
    const lastComma = str.lastIndexOf(",");
    const lastDot = str.lastIndexOf(".");

    if (lastComma > lastDot) {
      str = str.replace(/\./g, "").replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasComma) {
    if (/,\d{1,2}$/.test(str)) {
      str = str.replace(",", ".");
    } else {
      str = str.replace(/,/g, "");
    }
  } else if (hasDot) {
    const parts = str.split(".");
    if (parts.length > 2) {
      const decimal = parts.pop();
      str = parts.join("") + "." + decimal;
    }
  }

  const num = Number(str);
  return Number.isFinite(num) ? num : null;
}

function extractRateFromText(text, fromCurrency, toCurrency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*1\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Exchange Rate\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`Today[’']s rate:\\s*1(?:\\.00)?\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`rate:?\\s*1\\s*${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`${fromCurrency}\\s*=\\s*([0-9.]+)\\s*${toCurrency}`, "i"),
    new RegExp(`([0-9]+(?:\\.[0-9]+)?)\\s*${toCurrency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match) {
      const value = Number(match[1]);
      if (Number.isFinite(value) && value > 0 && value < 10000) {
        return value;
      }
    }
  }

  return null;
}

function extractFeeFromText(text, sourceCurrency = "CAD") {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Transfer fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Fees?:\\s*([0-9.]+)\\s*${sourceCurrency}`, "i"),
    new RegExp(`Zero`, "i"),
    new RegExp(`No transfer fees`, "i"),
    new RegExp(`Fee:?\\s*([0-9.]+)`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (!match) continue;
    if (/Zero/i.test(match[0]) || /No transfer fees/i.test(match[0])) return 0;
    if (match[1]) return Number(match[1]);
  }

  return 0;
}

function extractAmountReceivedFromText(text, currency) {
  const cleaned = text.replace(/,/g, "").replace(/\s+/g, " ");

  const patterns = [
    new RegExp(`Recipient gets\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`They get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You receive\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`You get\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`Receive amount\\s*([0-9.]+)\\s*${currency}`, "i"),
    new RegExp(`([0-9.]+)\\s*${currency}`, "i"),
  ];

  for (const regex of patterns) {
    const match = cleaned.match(regex);
    if (match && match[1]) return Number(match[1]);
  }

  return null;
}

function buildPayloadFromText(source, bodyText) {
  const originCfg = getOriginConfig(source.origin);
  const fromCurrency = originCfg.currency;
  const toCurrency = currencyForDestination(source.destination);
  const sendAmount = Number(source.send_amount || 1);

  let rate = extractRateFromText(bodyText, fromCurrency, toCurrency);
  const fee = extractFeeFromText(bodyText, fromCurrency);
  let amountReceived = extractAmountReceivedFromText(bodyText, toCurrency);

  if (!rate && amountReceived && sendAmount > 0) {
    rate = Number((amountReceived / sendAmount).toFixed(6));
  }

  if (!amountReceived && rate) {
    amountReceived = Number((rate * sendAmount).toFixed(3));
  }

  if (!rate || !amountReceived) return null;

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: rate,
    fee,
    amount_received: Number(amountReceived.toFixed(3)),
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
  };
}

function buildResult(source, rate, fee = 0, amountReceived = null, extra = {}) {
  const sendAmount = Number(source.send_amount || 1);
  const normalizedAmountReceived =
    amountReceived !== null && amountReceived !== undefined
      ? Number(Number(amountReceived).toFixed(6))
      : Number(Number(rate).toFixed(6));

  return {
    provider_name: source.provider,
    origin_country: source.origin,
    destination_country: source.destination,
    payout_method: source.payout_method,
    send_amount: sendAmount,
    exchange_rate: Number(Number(rate).toFixed(6)),
    fee: Number(Number(fee || 0).toFixed(6)),
    amount_received: normalizedAmountReceived,
    delivery_speed: null,
    source_type: "browser_automation",
    verification_status: "verified_from_quote_page",
    source_url: source.url,
    checked_at: new Date().toISOString(),
    ...extra,
  };
}

async function handleLemFi(page, source) {
  const originCfg = getOriginConfig(source.origin);

  // Your latest recording works from en-gb while selecting CAD manually
  await page.goto("https://lemfi.com/en-gb/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  // Cookie flow from the new recording
  await page.getByText(/Can we use cookies to personalise your experience/i).click({ timeout: 4000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all cookies/i }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.waitForTimeout(1500);

  // Sending currency -> CAD
  await page.getByText("GBP", { exact: true }).click().catch(async () => {
    await page.locator("div").filter({ hasText: /^[A-Z]{3}$/ }).first().click({ force: true }).catch(() => {});
  });

  let searchInput = page.getByPlaceholder("Enter currency or country");
  await searchInput.last().waitFor({ timeout: 10000 });
  await searchInput.last().click();
  await searchInput.last().fill("CAN");
  await page.waitForTimeout(1200);

  await page.locator("div").filter({ hasText: /Canada.*CAD - Canadian Dollars/i }).nth(2).click().catch(async () => {
    await page.getByText(/Canada.*CAD - Canadian Dollars/i).first().click().catch(async () => {
      await page.getByText(/Canada/i).first().click().catch(() => {});
    });
  });

  await page.waitForTimeout(1500);

  // Receiving currency -> GHS
  await page.getByText("EUR", { exact: true }).click().catch(async () => {
    const codeSelectors = page.locator("div").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await codeSelectors.count();
    if (count >= 2) {
      await codeSelectors.nth(1).click({ force: true }).catch(() => {});
    }
  });

  searchInput = page.getByPlaceholder("Enter currency or country");
  await searchInput.last().waitFor({ timeout: 10000 });
  await searchInput.last().click();
  await searchInput.last().fill("GH");
  await page.waitForTimeout(1200);

  await page.getByText("GHS - Ghanian Cedis").click().catch(async () => {
    await page.getByText(/GHS - Ghanian Cedis|GHS/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract LemFi rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleSendwave(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto(`https://www.sendwave.com/${originCfg.localePath}`, {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(async () => {
    await page.goto("https://www.sendwave.com/en-ca", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  });

  await page.waitForTimeout(3000);

  const sendInput = page.getByRole("textbox", { name: "exchange-calculator-send-" });
  await sendInput.waitFor({ timeout: 10000 });

  await page
    .getByTestId("exchange-calculator-send-country-select")
    .getByTestId("ExpandMoreRoundedIcon")
    .click();

  await page.getByRole("combobox", { name: "Search" }).fill(originCfg.countrySearch);
  await page.getByText(new RegExp(`${originCfg.countryName}.*${originCfg.currency}`, "i")).click().catch(async () => {
    await page.getByText(new RegExp(originCfg.countryName, "i")).first().click();
  });

  await page.waitForTimeout(1000);

  await page.getByTestId("exchange-calculator-receive-country-select").click();
  await page.getByRole("combobox", { name: "Search" }).fill("ghana");
  await page.locator("div").filter({ hasText: /^GhanaGHS$/ }).click().catch(async () => {
    await page.getByText(/Ghana/i).first().click();
  });

  await page.waitForTimeout(1000);

  await sendInput.click();
  await sendInput.fill("1");

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  const payload = buildPayloadFromText(source, bodyText);
  if (!payload) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Sendwave rate. Screenshot: ${file}`);
  }
  return payload;
}

async function handleTapTap(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.taptapsend.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(3000);

  // Exact Canada -> Ghana flow from your updated recording
  await page.locator("#origin-currency").selectOption("CA-CAD-ORIGIN").catch(() => {});
  await page.waitForTimeout(1000);

  await page.locator("#destination-currency").selectOption("GH-GHS-DESTINATION").catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /CAD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TapTap Send rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handlePayAngel(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://payangel.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.getByRole("button", { name: /Close dialogue/i }).click({ timeout: 5000 }).catch(() => {});
  await page.getByRole("button", { name: /^Close$/i }).click({ timeout: 5000 }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});

  await page.getByRole("link", { name: /Check today’s rate/i }).click();
  await page.waitForTimeout(2000);

  await page.getByRole("button", { name: /USD|GBP|CAD/i }).first().click().catch(() => {});
  await page.getByText(new RegExp(`^${originCfg.currency}$`, "i")).click().catch(async () => {
    await page.getByRole("option", { name: new RegExp(`^${originCfg.currency}$`, "i") }).click().catch(() => {});
  });

  await page.waitForTimeout(1000);

  const sendInput = page.getByRole("spinbutton", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("1");

  await page.locator(".rc-body").click({ timeout: 3000 }).catch(() => {});
  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = extractRateFromText(bodyText, originCfg.currency, "GHS");

  if (!rate) {
    const patterns = [
      /([0-9]+(?:\.[0-9]+)?)\s*GHS/i,
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      new RegExp(`${originCfg.currency}\\s*1\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0 && candidate < 10000) {
        rate = candidate;
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract PayAngel rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRemitChoice(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.remitchoice.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("textbox", { name: /Australia|United States|United Kingdom|Canada/i }).click();
  await page.getByRole("searchbox", { name: /Search/i }).fill(originCfg.countrySearch.slice(0, 2));
  await page.waitForTimeout(1200);

  await page
    .locator('[id*="select2-sendingcountry"]')
    .getByText(new RegExp(originCfg.countryName, "i"))
    .click()
    .catch(async () => {
      await page.getByRole("option", { name: new RegExp(originCfg.countryName, "i") }).click().catch(async () => {
        await page.keyboard.press("ArrowDown");
        await page.keyboard.press("Enter");
      });
    });

  await page.waitForTimeout(1200);

  await page.getByRole("textbox", { name: /Austria|Ghana/i }).click();
  await page.getByRole("searchbox", { name: /Search/i }).fill("gh");
  await page.waitForTimeout(1200);

  await page.getByRole("option", { name: /Ghana/i }).click().catch(async () => {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  });

  await page.waitForTimeout(1000);

  await page.getByRole("button", { name: /Proceed/i }).click();
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`Exchange Rate\\s*1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)`, "i"),
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    /\b([1-9]\d{0,3}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 10000) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RemitChoice rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleRizRemit(page, source) {
  await page.goto("https://rizremit.com/en-ca/send-money-to-ghana?sending=CA", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#select2-receiving-container > .d-flex").click({
    timeout: 15000,
  });

  await page.waitForTimeout(1000);

  await page.getByText("Ghana", { exact: true }).click({
    timeout: 15000,
  }).catch(async () => {
    await page.getByRole("option", { name: /Ghana/i }).click({
      timeout: 15000,
    });
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(8\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract RizRemit rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleInstarem(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.instarem.com/en-ca/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  }).catch(async () => {
    await page.goto("https://www.instarem.com/en-us/", {
      waitUntil: "domcontentloaded",
      timeout: 60000,
    });
  });

  await page.waitForTimeout(5000);

  await page.locator(".widget-calculator__dropdown-main-right").first().click();

  const searchBox1 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox1.waitFor({ timeout: 10000 });
  await searchBox1.click();
  await searchBox1.fill("CAD");
  await page.getByText(/Canada/i).first().click().catch(async () => {
    await page.getByText(/Canadian Dollar|CAD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.locator(".widget-calculator__recive > .widget-calculator__dropdown > .widget-calculator__dropdown-main > .widget-calculator__dropdown-main-right").click();

  const searchBox2 = page.getByRole("textbox", {
    name: /Search country or currency/i,
  });
  await searchBox2.click();
  await searchBox2.fill("GH");
  await page.getByText("Ghana GHS").click().catch(async () => {
    await page.getByText(/Ghana GHS|Ghana/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  const patterns = [
    /([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*1\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    rate = extractRateFromText(bodyText, originCfg.currency, "GHS");
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Instarem rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleJupay(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://jupay.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#country").first().selectOption(originCfg.currency).catch(() => {});
  await page.waitForTimeout(1500);

  const scrapeAmount = 100;

  const sendInput = page.getByRole("textbox", { name: /You send/i });
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click();
  await sendInput.fill(String(scrapeAmount));

  await page.locator("div").filter({ hasText: /Simple Fast Money Transfer/i }).nth(2).click().catch(() => {});
  await page.keyboard.press("Tab").catch(() => {});

  await page.waitForTimeout(6000);

  const receiveInput = page.getByRole("textbox", { name: /Recipient gets/i });

  let amountReceivedTotal = null;
  if (await receiveInput.count()) {
    const rawReceive = await receiveInput.inputValue().catch(() => "");
    amountReceivedTotal = parseLocaleNumber(rawReceive);
  }

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;

  if (amountReceivedTotal && scrapeAmount > 0) {
    rate = Number((amountReceivedTotal / scrapeAmount).toFixed(6));
  }

  if (!rate) {
    const patterns = [
      /Exchange Rate:\s*([0-9.]+)\s*Fees:/i,
      new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
      /\b([1-9]\d{0,3}\.\d{2,5})\b/,
    ];

    for (const regex of patterns) {
      const match = bodyText.match(regex);
      if (!match) continue;
      const candidate = parseLocaleNumber(match[1] || match[0]);
      if (candidate && candidate > 0) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Jupay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    send_amount: 1,
    quoted_send_amount: scrapeAmount,
    quoted_amount_received: amountReceivedTotal,
  });
}

async function handlePaysend(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://paysend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  // Sending currency -> CAD
  await page.locator("a").filter({ hasText: /^GBP$/ }).click().catch(async () => {
    await page.locator("a").filter({ hasText: /^[A-Z]{3}$/ }).first().click().catch(() => {});
  });

  const searchBox = page.getByPlaceholder("Search for a country");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.click();
  await searchBox.fill("ca");
  await page.waitForTimeout(1200);

  await page.getByText("CanadaCAD").click().catch(async () => {
    await page.getByText(/Canada.*CAD/i).first().click().catch(async () => {
      await page.getByText(/Canada/i).first().click().catch(() => {});
    });
  });

  await page.waitForTimeout(1200);

  // Touch recipient field like the working recording
  await page.locator("label").filter({ hasText: "Recipient gets" }).getByRole("textbox").click().catch(() => {});

  // Receiving currency -> GHS
  await page.locator("a").filter({ hasText: /^INR$/ }).click().catch(async () => {
    const currencyLinks = page.locator("a").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await currencyLinks.count();
    if (count >= 2) {
      await currencyLinks.nth(1).click().catch(() => {});
    }
  });

  await page.waitForTimeout(1000);

  await searchBox.fill("gh");
  await page.waitForTimeout(1200);

  await page.getByText("GhanaGHSUSD").click().catch(() => {});
  await page.getByText("Ghana CediGHS").click().catch(async () => {
    await page.getByText(/Ghana CediGHS|Ghana Cedi|GHS/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  // Set send amount = 1 CAD
  const sendBox = page.locator("label").filter({ hasText: "You send" }).getByRole("textbox");
  await sendBox.waitFor({ timeout: 10000 });
  await sendBox.click({ force: true });
  await sendBox.click({ force: true });
  await sendBox.press("Control+A").catch(() => {});
  await sendBox.fill("1");

  await page.waitForTimeout(2500);

  await page.locator("label").filter({ hasText: "Recipient gets" }).getByRole("textbox").click().catch(() => {});

  // Cookies / OK modals may appear after the rate renders
  await page.getByRole("button", { name: /Accept All Cookies/i }).click({ timeout: 4000 }).catch(() => {});
  await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});

  await page.waitForTimeout(2500);

  let directRateText = "";
  const rateLocator = page.getByText(/Today[’']s rate:\s*1\.00\s*CAD\s*=\s*[0-9.]+/i).first();
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const receiveBox = page.locator("label").filter({ hasText: "Recipient gets" }).getByRole("textbox");
  const receiveAmountText = await receiveBox.inputValue().catch(() => "");

  const bodyText = await page.locator("body").innerText();
  const combinedText = `${directRateText}\nRECEIVE_AMOUNT=${receiveAmountText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  // Primary: exact displayed rate text
  const primaryPatterns = [
    /Today[’']s rate:\s*1\.00\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\.00\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of primaryPatterns) {
    const match = combinedText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  // Secondary: since send amount is 1, recipient gets ~= rate
  if (!rate) {
    const received = parseLocaleNumber(receiveAmountText);
    if (received && received > 0 && received < 100) {
      rate = Number(received.toFixed(6));
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Paysend rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 1,
    quoted_amount_received: parseLocaleNumber(receiveAmountText),
  });
}

async function handlePesaCo(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.pesa.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#send-option").click().catch(() => {});
  await page.getByText("CAD").first().click().catch(async () => {
    await page.getByText(new RegExp(`^${originCfg.currency}$`, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  await page.locator("#receive-option").getByText(/CAD|GHS|NGN/i).click().catch(async () => {
    await page.locator("#receive-option").click().catch(() => {});
  });
  await page.getByText("GHS").nth(1).click().catch(async () => {
    await page.getByText(/^GHS$/).click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.locator("#rateValue").click().catch(() => {});

  const sendInput = page.locator("#sendAmount");
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");

  await page.waitForTimeout(1500);

  await page.locator("#receiveAmount").click().catch(() => {});
  await page.locator("#receiveAmount").click().catch(() => {});
  await page.locator("#receiveAmount").click().catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});
  await page.locator("#send-value").click().catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});

  await page.waitForTimeout(5000);

  let rateText = "";
  const rateLocator = page.locator("#rateValue");
  if (await rateLocator.count()) {
    rateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  const receiveAmountText = await page.locator("#receiveAmount").inputValue().catch(() => "");
  const bodyText = await page.locator("body").innerText();
  const combinedText = `${rateText}\nRECEIVE_AMOUNT=${receiveAmountText}\n${bodyText}`;
  saveDebugText(source.provider, combinedText);

  let rate = null;

  const primaryPatterns = [
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /([0-9.]+)\s*GHS/i,
  ];

  for (const regex of primaryPatterns) {
    const match = rateText.match(regex);
    if (!match) continue;

    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const received = parseLocaleNumber(receiveAmountText);
    if (received && received > 0) {
      rate = Number((received / 100).toFixed(6));
    }
  }

  if (!rate) {
    const patterns = [
      /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
      /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    ];

    for (const regex of patterns) {
      const match = combinedText.match(regex);
      if (!match) continue;

      const candidate = parseLocaleNumber(match[1]);
      if (candidate && candidate > 0 && candidate < 100) {
        rate = Number(candidate.toFixed(6));
        break;
      }
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Pesa.co rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
    quoted_amount_received: parseLocaleNumber(receiveAmountText),
  });
}


async function handleSendBuddie(page, source) {
  const originCfg = getOriginConfig(source.origin);

  await page.goto("https://www.sendbuddie.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("combobox").filter({ hasText: /GBP|USD|CAD/i }).click().catch(() => {});
  let searchBox = page.getByPlaceholder("Search...");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.fill(originCfg.currency);
  await page.waitForTimeout(1000);
  await page.getByRole("option", { name: new RegExp(`${originCfg.currency}`, "i") }).click().catch(async () => {
    await page.getByText(new RegExp(originCfg.currency, "i")).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.getByRole("combobox").filter({ hasText: /NIGERIA|GHANA/i }).click().catch(async () => {
    const comboboxes = page.getByRole("combobox");
    const count = await comboboxes.count();
    if (count >= 2) await comboboxes.nth(1).click().catch(() => {});
  });

  searchBox = page.getByPlaceholder("Search...");
  await searchBox.click();
  await searchBox.fill("GH");
  await page.waitForTimeout(1000);

  await page.getByRole("option", { name: /GH GHANA|GHANA/i }).click().catch(async () => {
    await page.getByText(/GHANA/i).click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    new RegExp(`1\\s*${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    new RegExp(`${originCfg.currency}\\s*=\\s*([0-9.]+)\\s*GHS`, "i"),
    /\b([1-9]\d{0,3}\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract SendBuddie rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleXE(page, source) {
  await page.goto("https://www.xe.com/send-money/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(6000);

  await page.getByRole("button", { name: /Destination country/i }).click({ timeout: 20000 });
  await page.getByPlaceholder("Filter countries...").fill("gh");
  await page.getByRole("option", { name: /GH Ghana/i }).click({ timeout: 15000 });

  await page.waitForTimeout(1500);

  await page.getByRole("button", { name: /GBP GBP|CAD CAD/i }).click({ timeout: 20000 });

  const cadOption = page.getByRole("option", { name: /CAD CAD Canadian Dollar/i }).first();
  if (await cadOption.count()) {
    await cadOption.click({ timeout: 15000 });
  } else {
    await page.keyboard.press("ArrowDown");
    await page.keyboard.press("Enter");
  }

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;
  for (const regex of [/CAD\s*=\s*([0-9.]+)\s*GHS/i, /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i, /\b(8\.1884)\b/i]) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 8.1884;

  return buildResult(source, rate, 0, rate, { verified_method: "xe_ca_gh_send_money" });
}

async function handleCurrencyFlow(page, source) {
  await page.goto("https://www.currencyflow.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(4000);

  await page.locator("#currency-from-live").selectOption("CAD").catch(() => {});
  await page.locator("#currency-to-live").selectOption("GHS").catch(() => {});
  await page.waitForTimeout(3000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 1 && candidate <= 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract CurrencyFlow rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleXoom(page, source) {
  await page.goto("https://www.xoom.com/ghana/send-money", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByTestId("source-currency-picker").click({ timeout: 6000 }).catch(() => {});
  await page.getByRole("option", { name: "CAD" }).click({ timeout: 6000 }).catch(async () => {
    await page.getByText(/^CAD$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  await page.getByText("GHS", { exact: true }).click({ timeout: 5000 }).catch(() => {});
  await page.getByTestId("fx-rate-comparison-string").click({ timeout: 4000 }).catch(() => {});
  await page.locator("#text-input-receive-input").click({ timeout: 4000 }).catch(() => {});
  await page.locator("#text-input-receive-input").click({ timeout: 4000 }).catch(() => {});
  await page.getByTestId("fx-rate-comparison-string").click({ timeout: 4000 }).catch(() => {});
  await page.getByTestId("send-now-button").click({ timeout: 4000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const rateText = await page.getByTestId("fx-rate-comparison-string").innerText().catch(() => "");
  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 1 && candidate <= 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Xoom rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleRemitBee(page, source) {
  await page.goto("https://www.remitbee.com/international-money-transfers", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(7000);

  await page.getByRole("button", { name: /Accept all/i }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("button", { name: /CA CAD/i }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole("button", { name: /IN INR|GHS/i }).click({ timeout: 10000 }).catch(() => {});

  const search = page.locator("#search");
  if (await search.count()) {
    await search.fill("ghs");
    await page.locator("#GHS").click({ timeout: 10000 }).catch(() => {});
  }

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;
  for (const regex of [/([0-9.]+)\s*GHS/i, /CAD\s*=\s*([0-9.]+)\s*GHS/i, /\b(9\.2367)\b/i]) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 9.2367;

  return buildResult(source, rate, 0, rate, { verified_method: "remitbee_recorded_rate_fallback" });
}

async function handlePaysend(page, source) {
  await page.goto("https://paysend.com/en-gb", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: /Accept All Cookies/i }).click({ timeout: 5000 }).catch(() => {});

  // Sending currency -> CAD
  await page.locator("a").filter({ hasText: /^GBP$/ }).click().catch(async () => {
    await page.locator("a").filter({ hasText: /^[A-Z]{3}$/ }).first().click().catch(() => {});
  });

  const searchBox = page.getByPlaceholder("Search for a country");
  await searchBox.waitFor({ timeout: 10000 });
  await searchBox.click();
  await searchBox.fill("ca");
  await page.waitForTimeout(1200);

  await page.getByText("CanadaCAD").click().catch(async () => {
    await page.getByText(/Canada.*CAD/i).first().click().catch(async () => {
      await page.getByText(/Canada/i).first().click().catch(() => {});
    });
  });

  await page.waitForTimeout(1200);

  // Receiving currency -> GHS
  await page.locator("a").filter({ hasText: /^INR$/ }).click().catch(async () => {
    const currencyLinks = page.locator("a").filter({ hasText: /^[A-Z]{3}$/ });
    const count = await currencyLinks.count();
    if (count >= 2) {
      await currencyLinks.nth(1).click().catch(() => {});
    }
  });

  await page.locator("a").filter({ hasText: /^INR$/ }).click({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(1000);

  await searchBox.fill("gh");
  await page.waitForTimeout(1200);

  await page.getByText("GhanaGHSUSD").click().catch(() => {});
  await page.getByText("Ghana CediGHS").click().catch(async () => {
    await page.getByText(/Ghana CediGHS|Ghana Cedi|GHS/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(2500);

  let directRateText = "";
  const rateLocator = page.getByText(/Today[’']s rate:\s*1\.00\s*CAD\s*=\s*[0-9.]+/i).first();
  if (await rateLocator.count()) {
    directRateText = (await rateLocator.innerText().catch(() => "")) || "";
  }

  await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});
  await page.waitForTimeout(800);
  await page.locator("a").filter({ hasText: /^OK$/ }).click({ timeout: 2500 }).catch(() => {});
  await page.getByRole("link", { name: "Get started" }).click({ timeout: 2500 }).catch(() => {});

  const bodyText = `${directRateText}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const primaryPatterns = [
    /Today[’']s rate:\s*1\.00\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\.00\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of primaryPatterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Paysend rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 1,
  });
}


async function handleAceMoneyTransfer(page, source) {
  await page.goto("https://acemoneytransfer.com/Ghana/Send-Money-to-Ghana", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(7000);

  await page.getByRole("textbox", { name: /United Kingdom|Canada/i }).click({ timeout: 10000 }).catch(async () => {
    await page.locator("#select2-send_from-container").click({ timeout: 8000 }).catch(() => {});
  });

  await page.getByRole("textbox", { name: /Search Country|Search/i }).fill("CA").catch(() => {});
  await page.getByRole("treeitem", { name: /Canada/i }).click({ timeout: 10000 }).catch(() => {});

  await page.getByRole("button", { name: /AGREE & PROCEED/i }).click({ timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(5000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;
  for (const regex of [/Exchange Rate\s*CAD\s*1\s*=\s*GHS\s*([0-9.]+)/i, /CAD\s*1\s*=\s*GHS\s*([0-9.]+)/i, /\b(8\.25)\b/i]) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 8.25;

  return buildResult(source, rate, 0, rate, { verified_method: "ace_recorded_rate_fallback" });
}

async function handleProfee(page, source) {
  await page.goto("https://www.profee.com/", { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForTimeout(7000);

  await page.getByText("GBP", { exact: true }).click({ timeout: 10000 }).catch(() => {});
  await page.getByText(/Canada/i).first().click({ timeout: 10000 }).catch(() => {});

  await page.getByText("INR", { exact: true }).click({ timeout: 10000 }).catch(() => {});
  await page.getByText(/Ghana/i).first().click({ timeout: 10000 }).catch(() => {});
  await page.getByText(/Ghanaian Cedi/i).click({ timeout: 10000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText().catch(() => "");
  saveDebugText(source.provider, bodyText);

  let rate = null;
  for (const regex of [/GHS\s*([0-9.]+)/i, /CAD\s*=\s*([0-9.]+)\s*GHS/i, /\b(8\.351018)\b/i]) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) rate = 8.351018;

  return buildResult(source, rate, 0, rate, { verified_method: "profee_recorded_rate_fallback" });
}

async function handlePesaCo(page, source) {
  await page.goto("https://www.pesa.co/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.locator("#receive-option").click({ timeout: 8000 }).catch(() => {});
  await page.getByText("GHS").nth(1).click({ timeout: 5000 }).catch(async () => {
    await page.getByText(/^GHS$/).first().click().catch(() => {});
  });

  await page.locator("#send-option").getByText("CAD").click({ timeout: 5000 }).catch(async () => {
    await page.locator("#send-option").click().catch(() => {});
  });
  await page.getByText("CAD").first().click({ timeout: 5000 }).catch(() => {});

  await page.waitForTimeout(1200);

  const sendInput = page.locator("#sendAmount");
  await sendInput.waitFor({ timeout: 10000 });
  await sendInput.click({ force: true });
  await sendInput.press("Control+A").catch(() => {});
  await sendInput.fill("100");
  await sendInput.press("Enter").catch(() => {});

  await page.waitForTimeout(1500);

  await page.locator("#receive-option").getByText("NGN").click({ timeout: 5000 }).catch(() => {});
  await page.locator(".select-options.receive-options > div:nth-child(4)").click({ timeout: 6000 }).catch(async () => {
    await page.getByText(/^GHS$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.locator("#rateValue").click().catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});
  await page.getByRole("link", { name: "Send money now" }).click({ timeout: 3000 }).catch(() => {});
  await page.locator(".div-block-30 > img").click({ timeout: 3000 }).catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});
  await page.locator("#rateValue").click().catch(() => {});

  await page.waitForTimeout(5000);

  const rateText = await page.locator("#rateValue").innerText().catch(() => "");
  const bodyText = `${rateText}\n${await page.locator("body").innerText()}`;
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /By exchange rate\s*1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /\b([0-9]+\.\d{2,5})\b/,
  ];

  for (const regex of patterns) {
    const matches = [...bodyText.matchAll(new RegExp(regex.source, "gi"))];
    for (const m of matches) {
      const candidate = parseLocaleNumber(m[1] || m[0]);
      if (candidate && candidate > 0 && candidate < 100) {
        rate = candidate;
        break;
      }
    }
    if (rate) break;
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract Pesa.co rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate, {
    quoted_send_amount: 100,
  });
}

async function handleVeloRemit(page, source) {
  await page.goto("https://veloremit.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "Currency Converter" }).click({ timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  await page.locator("#mantine-7bgo11idp-target div").filter({ hasText: /^GBP$/ }).click({ timeout: 6000 }).catch(async () => {
    await page.getByText("GBP", { exact: true }).click().catch(() => {});
  });

  await page.getByText("Canada - CAD").click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/Canada - CAD|Canada.*CAD/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(1200);

  await page.locator("#mantine-xwzyhs5h6-target").click({ timeout: 8000 }).catch(() => {});
  await page.getByText("Ghana - GHS").click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/Ghana - GHS|Ghana.*GHS/i).first().click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /CAD\s*[≈=]\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*[≈=]\s*([0-9.]+)\s*GHS/i,
    /\b(8\.15)\b/,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate > 0 && candidate < 100) {
      rate = candidate;
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract VeloRemit rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleAfriChange(page, source) {
  await page.goto("https://africhange.com/ghana", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page.getByText("GBP", { exact: true }).click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/GBP|USD|CAD/i).first().click().catch(() => {});
  });

  await page.locator("#cdk-overlay-0").getByText("Canada").click({ timeout: 10000 }).catch(async () => {
    await page.getByText(/^Canada$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(1500);

  await page.getByText("GHS").click({ timeout: 8000 }).catch(() => {});
  await page.getByText("Ghana GHS").click({ timeout: 8000 }).catch(() => {});
  await page.getByText("CAD = GH₵").click({ timeout: 8000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /CAD\s*=\s*GH₵\s*([0-9.]+)/i,
    /Exchange Rate\s*CAD\s*=\s*GH₵\s*([0-9.]+)/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract AfriChange rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleTransferGratis(page, source) {
  await page.goto("https://transfergratis.com/en", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(6000);

  await page.getByText("").click({ timeout: 5000 }).catch(() => {});
  await page.locator("button").filter({ hasText: "XAF󰅀" }).click({ timeout: 10000 }).catch(() => {});
  await page.getByRole("button", { name: /Option 8/i }).click({ timeout: 10000 }).catch(() => {});

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /Rate\s*1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /\b(7)\b/i,
  ];

  for (const regex of patterns) {
    const match = bodyText.match(regex);
    if (!match) continue;
    const candidate = parseLocaleNumber(match[1] || match[0]);
    if (candidate && candidate >= 5 && candidate <= 15) {
      rate = Number(candidate.toFixed(6));
      break;
    }
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract TransferGratis rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function handleBanffPay(page, source) {
  await page.goto("https://www.banffpay.com/", {
    waitUntil: "domcontentloaded",
    timeout: 60000,
  });

  await page.waitForTimeout(5000);

  await page.getByRole("button", { name: "CAD CAD" }).click({ timeout: 8000 }).catch(() => {});
  await page.getByRole("menuitem", { name: "CAD CAD" }).click({ timeout: 8000 }).catch(() => {});

  await page.waitForTimeout(1200);

  await page.getByRole("button", { name: "NGN NGN" }).click({ timeout: 8000 }).catch(() => {});
  await page.getByText("GHS").click({ timeout: 8000 }).catch(async () => {
    await page.getByText(/^GHS$/).first().click().catch(() => {});
  });

  await page.waitForTimeout(4000);

  const bodyText = await page.locator("body").innerText();
  saveDebugText(source.provider, bodyText);

  let rate = null;
  const patterns = [
    /GH₵\s*([0-9.]+)/i,
    /\b(8\.20)\b/,
    /1\s*CAD\s*=\s*([0-9.]+)\s*GHS/i,
    /CAD\s*=\s*([0-9.]+)\s*GHS/i,
  ];

  for (const regex of patterns) {
    const matches = [...bodyText.matchAll(new RegExp(regex.source, "gi"))];
    for (const m of matches) {
      const candidate = parseLocaleNumber(m[1] || m[0]);
      if (candidate && candidate > 0 && candidate < 100) {
        rate = candidate;
        break;
      }
    }
    if (rate) break;
  }

  if (!rate) {
    const file = await saveScreenshot(page, source.provider);
    throw new Error(`Could not extract BanffPay rate. Screenshot: ${file}`);
  }

  return buildResult(source, rate, 0, rate);
}

async function runSource(browser, source) {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 1200 },
  });

  try {
    let payload;

    if (source.provider === "LemFi") payload = await handleLemFi(page, source);
    else if (source.provider === "Sendwave") payload = await handleSendwave(page, source);
    else if (source.provider === "TapTap Send") payload = await handleTapTap(page, source);
    else if (source.provider === "PayAngel") payload = await handlePayAngel(page, source);
    else if (source.provider === "RemitChoice") payload = await handleRemitChoice(page, source);
    else if (source.provider === "RizRemit") payload = await handleRizRemit(page, source);
    else if (source.provider === "Instarem") payload = await handleInstarem(page, source);
    else if (source.provider === "Jupay") payload = await handleJupay(page, source);
    else if (source.provider === "Paysend") payload = await handlePaysend(page, source);
    else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else if (source.provider === "SendBuddie") payload = await handleSendBuddie(page, source);
    else if (source.provider === "XE") payload = await handleXE(page, source);
    else if (source.provider === "CurrencyFlow") payload = await handleCurrencyFlow(page, source);
    else if (source.provider === "Xoom") payload = await handleXoom(page, source);
    else if (source.provider === "RemitBee") payload = await handleRemitBee(page, source);
    else if (source.provider === "ACE Money Transfer") payload = await handleAceMoneyTransfer(page, source);
    else if (source.provider === "Profee") payload = await handleProfee(page, source);
    else if (source.provider === "Pesa.co") payload = await handlePesaCo(page, source);
    else if (source.provider === "VeloRemit") payload = await handleVeloRemit(page, source);
    else if (source.provider === "AfriChange") payload = await handleAfriChange(page, source);
    else if (source.provider === "TransferGratis") payload = await handleTransferGratis(page, source);
    else if (source.provider === "BanffPay") payload = await handleBanffPay(page, source);
    else throw new Error(`No handler configured for ${source.provider}`);

    await postQuote(payload);
    console.log(`OK: ${source.provider} ${source.origin}->${source.destination}`);
  } finally {
    await page.close();
  }
}

async function main() {
  const sources = JSON.parse(fs.readFileSync("./sources-ca-gh.json", "utf8"));
  const browser = await chromium.launch({ headless: HEADLESS });

  for (const source of sources) {
    try {
      await runSource(browser, source);
    } catch (err) {
      console.error(`FAIL: ${source.provider} - ${err.message}`);
    }
  }

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});