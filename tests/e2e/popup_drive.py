import sys, time, tempfile, json
from playwright.sync_api import sync_playwright

import os
EXT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHOTS = os.environ.get("SHOTS", "/tmp/dayline-shots")
os.makedirs(SHOTS, exist_ok=True)
SEED = """
async () => {
  const { createStore, createChromeBackend } = await import('/src/lib/store.js');
  const { addDays, toDateStr } = await import('/src/lib/dates.js');
  const s = createStore(createChromeBackend());
  for (const it of await s.list()) await s.remove(it.id);
  const today = toDateStr(new Date());
  const d = (n) => addDays(today, n);
  await s.add({ title: 'Submit tax form', date: d(-2) });
  await s.add({ title: 'Send invoice to client', date: d(-1), time: '17:00', reminders: [{offsetMin: 10}] });
  await s.add({ title: 'Buy groceries', date: today, reminders: [{offsetMin: 0}] });
  await s.add({ title: 'Call mom', date: today, time: '23:30', type: 'event', reminders: [{offsetMin: 10}] });
  const vit = await s.add({ title: 'Take vitamins', date: d(-10), time: '23:00', recurrence: {freq: 'daily'}, reminders: [{offsetMin: 0}] });
  await s.add({ title: 'Dentist', date: d(1), time: '15:00', endTime: '16:00', type: 'event', reminders: [{offsetMin: 60}] });
  await s.add({ title: 'Gym', date: d(2), time: '07:00', recurrence: {freq: 'weekly', weekdays: [1,3,5]} });
  await s.add({ title: 'Team offsite', date: d(5) });
  await s.add({ title: 'Renew passport', date: d(24), reminders: [{offsetMin: 0}] });
  await s.add({ title: 'Learn guitar' });
  await s.add({ title: 'Clean the garage' });
  const done = await s.add({ title: 'Book flights' });
  await s.setDone(done.id, true);
  return (await s.list()).length;
}
"""

with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(), headless=False,
        args=["--headless=new", f"--disable-extensions-except={EXT}", f"--load-extension={EXT}", "--no-sandbox"],
        viewport={"width": 380, "height": 620}, device_scale_factor=2,
    )
    time.sleep(1.5)
    ext_id = ctx.service_workers[0].url.split('/')[2]
    page = ctx.new_page()
    errors = []
    page.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
    page.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
    url = f"chrome-extension://{ext_id}/src/popup/popup.html"
    page.goto(url)
    page.wait_for_selector("#add-input")
    print("seeded:", page.evaluate(SEED))
    page.reload(); page.wait_for_selector(".row")

    def shot(name): page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)
    def text(sel): return page.eval_on_selector_all(sel, "els => els.map(e => e.innerText.replace(/\\n+/g,' | '))")

    print("TAB counts:", text(".tab"))
    print("TODAY rows:", text(".row"))
    shot("01-today-light")

    # live preview
    page.fill("#add-input", "gym every monday at 7am")
    print("PREVIEW:", text("#preview .chip"))
    shot("02-preview-light")

    # add -> should land somewhere sensible
    page.press("#add-input", "Enter")
    page.wait_for_timeout(300)
    print("AFTER ADD tab:", page.eval_on_selector(".tab[aria-selected=true]", "e => e.dataset.tab"), "| rows:", len(page.query_selector_all(".row")))

    # add an undated item and a timed-today one
    page.fill("#add-input", "buy birthday present"); page.press("#add-input", "Enter"); page.wait_for_timeout(300)
    print("undated -> tab:", page.eval_on_selector(".tab[aria-selected=true]", "e => e.dataset.tab"))
    page.click(".tab[data-tab=upcoming]"); shot("03-upcoming-light")
    print("UPCOMING:", text(".section-head"))
    page.click(".tab[data-tab=general]"); shot("04-general-light")
    print("GENERAL:", text(".row .title"))

    # mark done + persistence
    page.click(".tab[data-tab=today]")
    first = page.query_selector(".row:not(.overdue) input.check")
    title = page.eval_on_selector(".row:not(.overdue) .title", "e => e.textContent")
    first.check(); page.wait_for_timeout(900)
    print("marked done:", title, "| rows now:", text(".row .title"))
    page.check("#show-done"); page.wait_for_timeout(200)
    print("with completed:", text(".row .title"))
    shot("05-today-showdone-light")

    # delete two-step
    page.click(".tab[data-tab=general]")
    n0 = len(page.query_selector_all(".row"))
    page.hover(".row"); page.click(".row .del"); page.wait_for_timeout(100)
    print("confirm label visible:", page.is_visible(".row .del.confirm .lbl"))
    page.click(".row .del.confirm"); page.wait_for_timeout(400)
    print("general rows before/after delete:", n0, len(page.query_selector_all(".row")))

    # reminder default select persists
    page.select_option("#add-reminder", "60"); page.wait_for_timeout(200)
    page.reload(); page.wait_for_selector("#add-reminder")
    print("default reminder after reload:", page.eval_on_selector("#add-reminder", "e => e.value"))

    # XSS check: titles are rendered as text
    page.fill("#add-input", "<img src=x onerror=window.__pwned=1> tomorrow"); page.press("#add-input", "Enter"); page.wait_for_timeout(300)
    print("xss executed:", page.evaluate("window.__pwned === 1"), "| img elements in list:", len(page.query_selector_all("#list img")))

    # dark mode
    page.emulate_media(color_scheme="dark")
    page.click(".tab[data-tab=today]"); page.wait_for_timeout(200)
    shot("06-today-dark")
    page.fill("#add-input", "dentist next friday 3pm"); shot("07-preview-dark")

    print("ERRORS:", errors or "none")
    ctx.close()
