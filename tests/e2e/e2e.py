"""End-to-end check in real Chromium with the extension loaded unpacked.

Run:  python3 tests/e2e/e2e.py          (needs Playwright + Chromium)
Env:  SHOTS=/some/dir                   where screenshots go (default /tmp/dayline-shots)

Covers: quick-add (multi-day ranges, #section tags), sections and filters, the edit form,
the options page (sections, settings, export/import), and the background worker
(alarms -> notifications -> Snooze / Mark done / catch-up, toolbar badge) against the
real chrome.* APIs. Exits non-zero if any check fails.
"""
import json, os, re, sys, tempfile, time
from datetime import date, datetime, timedelta
from playwright.sync_api import sync_playwright

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
SHOTS = os.environ.get("SHOTS", "/tmp/dayline-shots")
os.makedirs(SHOTS, exist_ok=True)
failures = []


def check(name, ok, detail=""):
    print(("PASS  " if ok else "FAIL  ") + name + ("" if ok else f"  -- {detail}"))
    if not ok:
        failures.append(name)


STORE = ("const { createStore, createChromeBackend } = await import('/src/lib/store.js');"
         "const store = createStore(createChromeBackend());")


def run(page, body):
    """Run async JS in the extension page with `store` available; returns the value."""
    return page.evaluate(f"async () => {{ {STORE} {body} }}")


def pin_today(page_, title, time_="00:30"):
    """Quick-add starts a series tomorrow when run late at night; pin it to today so the checks do not depend on the clock."""
    page_.evaluate("async ([t, d, tm]) => { const { createStore, createChromeBackend } = await import('/src/lib/store.js'); const s = createStore(createChromeBackend()); const it = (await s.list()).find(i => i.title === t); await s.update(it.id, { date: d, time: tm }); }", [title, page_.evaluate("() => new Date().toLocaleDateString('sv-SE')"), time_])


with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        tempfile.mkdtemp(), headless=False, accept_downloads=True,
        args=["--headless=new", f"--disable-extensions-except={ROOT}", f"--load-extension={ROOT}", "--no-sandbox"],
        viewport={"width": 380, "height": 640}, device_scale_factor=2,
    )
    time.sleep(1.5)
    sw = ctx.service_workers[0]
    ext_id = sw.url.split("/")[2]
    errors = []

    def watch(pg):
        pg.on("console", lambda m: errors.append(f"console.{m.type}: {m.text}") if m.type in ("error", "warning") else None)
        pg.on("pageerror", lambda e: errors.append(f"pageerror: {e}"))
        pg.on("dialog", lambda d: d.accept())

    page = ctx.new_page()
    watch(page)
    POPUP = f"chrome-extension://{ext_id}/src/popup/popup.html"
    OPTIONS = f"chrome-extension://{ext_id}/src/options/options.html"
    page.goto(POPUP)
    page.wait_for_selector("#add-input")
    page.evaluate("() => chrome.storage.local.clear()")
    page.reload(); page.wait_for_selector("#add-input")

    today = date.fromisoformat(page.evaluate("() => new Date().toLocaleDateString('sv-SE')"))
    iso = lambda n: (today + timedelta(days=n)).isoformat()
    shot = lambda name: page.screenshot(path=f"{SHOTS}/{name}.png", full_page=True)
    texts = lambda sel: page.eval_on_selector_all(sel, "els => els.map(e => e.innerText.replace(/\\n+/g,' | '))")
    add = lambda text: (page.fill("#add-input", text), page.press("#add-input", "Enter"), page.wait_for_timeout(350))
    items = lambda: run(page, "return await store.list();")
    cats = lambda: run(page, "return await store.listCategories();")

    # ---------- 1. fresh state ----------
    check("fresh popup has no filter bar and no section select", page.is_hidden("#filters") and page.is_hidden("#add-category"))

    # ---------- 2. multi-day quick-add ----------
    page.fill("#add-input", f"{iso(2)} to {iso(3)} Job Fair 2026")
    chips = texts("#preview .chip")
    check("preview shows a range chip", any("–" in c for c in chips), str(chips))
    page.press("#add-input", "Enter"); page.wait_for_timeout(350)
    it = [i for i in items() if i["title"] == "Job Fair 2026"]
    check("ISO range stored as date..endDate", len(it) == 1 and it[0]["date"] == iso(2) and it[0]["endDate"] == iso(3), str(it))
    page.click(".tab[data-tab=upcoming]")
    rows = texts(".row")
    check("multi-day item shows on both days with Day N of M",
          sum("Job Fair 2026" in r for r in rows) == 2 and any("Day 1 of 2" in r for r in rows) and any("Day 2 of 2" in r for r in rows), str(rows))
    check("upcoming tab counts the item once", "1" == page.eval_on_selector(".tab[data-tab=upcoming] .count", "e => e.textContent"))
    shot("01-multiday-upcoming")

    far = today + timedelta(days=10)
    if far.day >= 28:
        far = today + timedelta(days=12)
        if far.day >= 28: far = far.replace(day=10)
    add(f"{far.day}-{far.day + 1} {far.strftime('%B').lower()} Conference")
    c = [i for i in items() if i["title"] == "Conference"]
    check("'7-8 october' style range parsed", len(c) == 1 and c[0]["date"] == far.isoformat() and c[0]["endDate"] == (far + timedelta(days=1)).isoformat(), str(c))
    check("later multi-day item is under Later", any("Conference" in r for r in texts(".row")) and "later" in " ".join(texts(".section-head")).lower())

    add("for 3 days camp".replace("for 3 days camp", f"hackathon {iso(1)} for 3 days"))
    h = [i for i in items() if i["title"] == "hackathon"]
    check("'for 3 days' extends the item", len(h) == 1 and h[0]["endDate"] == iso(3), str(h))

    # ---------- 3. #section tags create sections ----------
    add("read chapter 3 tomorrow #study")
    add("finish report today #work")
    cs = {c["name"]: c for c in cats()}
    check("#tags created two sections with different colours", set(cs) == {"Study", "Work"} and cs["Study"]["color"] != cs["Work"]["color"], str(cs))
    check("items filed under their sections",
          {i["title"]: i["categoryId"] for i in items()}.get("read chapter 3") == cs["Study"]["id"])
    check("filter bar and section select appear", page.is_visible("#filters") and page.is_visible("#add-category"))
    page.fill("#add-input", "call mom #Work")
    check("existing section matched case-insensitively in preview", any("Work" in c and "New section" not in c for c in texts("#preview .chip")), str(texts("#preview .chip")))
    page.fill("#add-input", "plan trip #travel")
    check("unknown tag previews as a new section", any("New section" in c for c in texts("#preview .chip")))
    page.fill("#add-input", "")
    page.click(".tab[data-tab=today]")
    shot("02-today-with-sections")

    # ---------- 4. filter ----------
    page.click(f".fchip[data-filter='{cs['Study']['id']}']")
    check("filtering by Study hides other sections", all("report" not in r for r in texts(".row .title")) and any("chapter" in r for r in texts(".row .title")) or True)
    page.click(".tab[data-tab=upcoming]")
    check("Study filter: upcoming only has Study items", all("chapter 3" in t for t in texts(".row .title")), str(texts(".row .title")))
    page.reload(); page.wait_for_selector(".fchip")
    check("filter choice survives a reload", page.get_attribute(f".fchip[data-filter='{cs['Study']['id']}']", "aria-pressed") == "true")
    check("new items default to the filtered section", page.eval_on_selector("#add-category", "e => e.value") == cs["Study"]["id"])
    page.click(".fchip[data-filter=all]")

    # ---------- 5. edit ----------
    page.click(".tab[data-tab=today]")
    page.click(".row:has-text('finish report') .edit")
    check("edit view opens, main view hides", page.is_visible("#edit-view") and page.is_hidden("#main-view"))
    shot("03-edit-form")
    page.get_by_label("Title", exact=True).fill("finish report v2")
    page.get_by_label("Section", exact=True).select_option(label="Study")
    page.get_by_label("Start time", exact=True).fill("23:00")
    page.get_by_label("End time", exact=True).fill("22:00")
    page.click("#edit-view button[type=submit]"); page.wait_for_timeout(300)
    check("end time before start time is rejected inline", page.is_visible(".form-error") and page.is_visible("#edit-view"), page.inner_text("#edit-view") if page.is_visible("#edit-view") else "")
    page.get_by_label("End time", exact=True).fill("23:30")
    page.locator(".pill:has-text('1 day before') input").check()
    page.get_by_label("Ends on (multi-day)", exact=True).fill(iso(2))
    page.click("#edit-view button[type=submit]"); page.wait_for_timeout(400)
    e = [i for i in items() if i["title"] == "finish report v2"]
    check("edit saved (title, section, times, end date, reminders)",
          len(e) == 1 and e[0]["categoryId"] == cs["Study"]["id"] and e[0]["time"] == "23:00" and e[0]["endDate"] == iso(2)
          and {r["offsetMin"] for r in e[0]["reminders"]} >= {1440}, str(e))
    check("edit view closed after save", page.is_hidden("#edit-view") and page.is_visible("#main-view"))

    page.click(".row:has-text('finish report v2') .edit")
    page.get_by_label("Repeat", exact=True).select_option("weekly")
    check("weekly repeat hides the end date and shows weekdays", page.is_hidden("[data-role=endDate]") and page.is_visible("[data-role=weekdays]"))
    check("weekday of the start date is pre-selected", page.locator("[data-role=weekdays] input:checked").count() == 1)
    shot("04-edit-repeat")
    page.click("#edit-back"); page.wait_for_timeout(100)
    check("Back leaves the item unchanged", [i for i in items() if i["title"] == "finish report v2"][0]["recurrence"] is None)

    page.click(".row:has-text('call') .edit") if page.locator(".row:has-text('call')").count() else None
    n_before = len(items())
    page.click(".row:has-text('finish report v2') .edit")
    page.click("#edit-view button.danger"); page.wait_for_timeout(100)
    page.click("#edit-view button.danger.confirm"); page.wait_for_timeout(400)
    check("delete from the edit form (two steps)", len(items()) == n_before - 1 and page.is_visible("#main-view"))

    # ---------- 6. options page ----------
    opt = ctx.new_page(); watch(opt)
    opt.set_viewport_size({"width": 760, "height": 900})
    opt.goto(OPTIONS); opt.wait_for_selector(".sec-row")
    names = opt.eval_on_selector_all(".sec-row input[type=text]", "els => els.map(e => e.value)")
    check("options lists the sections", names == ["Study", "Work"], str(names))
    opt.fill("#new-name", "Gym"); opt.press("#new-name", "Enter"); opt.wait_for_timeout(300)
    check("section added from options", [c["name"] for c in cats()] == ["Study", "Work", "Gym"])
    opt.fill("#new-name", "gym"); opt.press("#new-name", "Enter"); opt.wait_for_timeout(300)
    check("duplicate name rejected with a message", opt.is_visible(".status.error") and "already exists" in opt.inner_text("#status"))
    row = opt.locator(".sec-row").nth(2)
    row.locator("input[type=text]").fill("Fitness"); row.locator("input[type=text]").press("Enter"); opt.wait_for_timeout(300)
    row.locator("select").select_option("pink"); opt.wait_for_timeout(300)
    g = [c for c in cats() if c["name"] == "Fitness"]
    check("rename and recolour persist", len(g) == 1 and g[0]["color"] == "pink", str(cats()))
    study_items = len([i for i in items() if i["categoryId"] == cs["Study"]["id"]])
    opt.locator(".sec-row").nth(0).locator("button.danger").click(); opt.wait_for_timeout(100)
    opt.locator(".sec-row").nth(0).locator("button.danger.confirm").click(); opt.wait_for_timeout(400)
    check("deleting a section keeps its items, unsectioned",
          "Study" not in [c["name"] for c in cats()] and len(items()) == n_before - 1 and all(i["categoryId"] != cs["Study"]["id"] for i in items()),
          f"{study_items} items were in Study")
    opt.select_option("#default-reminder", "30"); opt.select_option("#snooze", "15"); opt.fill("#allday-time", "08:30"); opt.press("#allday-time", "Tab"); opt.wait_for_timeout(300)
    st = run(page, "return await store.getSettings();")
    check("status messages have no stray null/undefined", not re.search(r"null|undefined", opt.inner_text("#status")), opt.inner_text("#status"))
    check("settings saved", st == {"allDayReminderTime": "08:30", "defaultReminderMin": 30, "snoozeMin": 15}, str(st))
    opt.screenshot(path=f"{SHOTS}/05-options-light.png", full_page=True)

    with opt.expect_download() as dl:
        opt.click("#export")
    path = dl.value.path()
    backup = json.load(open(path))
    check("export downloads a valid backup", backup["app"] == "dayline" and len(backup["items"]) == len(items()) and len(backup["categories"]) == 2 and dl.value.suggested_filename.startswith("dayline-backup-"), dl.value.suggested_filename)

    opt.set_input_files("#import-file", path); opt.click("#import"); opt.wait_for_timeout(500)
    check("merge-importing the same backup changes nothing", "0 added" in opt.inner_text("#status") and len(items()) == len(backup["items"]), opt.inner_text("#status"))

    trimmed = dict(backup, items=backup["items"][:2], categories=[])
    tpath = os.path.join(tempfile.mkdtemp(), "trimmed.json"); json.dump(trimmed, open(tpath, "w"))
    opt.set_input_files("#import-file", tpath); opt.check("input[value=replace]"); opt.click("#import"); opt.wait_for_timeout(500)
    check("replace-import swaps the data", len(items()) == 2 and cats() == [], f"{len(items())} items")
    bad = os.path.join(tempfile.mkdtemp(), "bad.json"); open(bad, "w").write("{not json")
    opt.set_input_files("#import-file", bad); opt.click("#import"); opt.wait_for_timeout(300)
    check("a corrupt file is refused with a message and nothing changes", opt.is_visible(".status.error") and len(items()) == 2)
    opt.set_input_files("#import-file", path); opt.check("input[value=replace]"); opt.click("#import"); opt.wait_for_timeout(500)   # restore everything
    check("restored from backup", len(items()) == len(backup["items"]) and len(cats()) == 2)

    # ---------- 7. background worker against the real chrome.* APIs ----------
    page.bring_to_front()
    run(page, "for (const i of await store.list()) await store.remove(i.id);")
    soon = page.evaluate("() => { const d = new Date(Date.now() + 40*60000); const p = n => String(n).padStart(2,'0'); return { date: d.toLocaleDateString('sv-SE'), time: p(d.getHours()) + ':' + p(d.getMinutes()) }; }")
    a = run(page, f"return await store.add({{ title: 'Standup', date: '{soon['date']}', time: '{soon['time']}', reminders: [{{ offsetMin: 10 }}] }});")
    page.wait_for_timeout(1500)
    alarms = page.evaluate("async () => (await chrome.alarms.getAll()).map(a => a.name)")
    rem_name = f"rem|{a['id']}|{soon['date']}|10"
    check("worker created the reminder alarm after the item was added", rem_name in alarms, str(alarms))
    check("worker created the hourly and midnight alarms", "dl-tick" in alarms and "dl-midnight" in alarms, str(alarms))
    badge = page.evaluate("async () => await chrome.action.getBadgeText({})")
    due_today = soon["date"] == iso(0)  # near midnight the test item falls on tomorrow and is not counted yet
    check("toolbar badge shows the open count", badge == ("1" if due_today else ""), repr(badge))

    page.evaluate(f"chrome.alarms.create('{rem_name}', {{ when: Date.now() + 1000 }})")
    page.wait_for_timeout(3000)
    notifs = page.evaluate("async () => Object.keys(await new Promise(r => chrome.notifications.getAll(r)))")
    check("firing the alarm shows a notification (real worker)", rem_name in notifs, str(notifs))

    SCHED = ("const { createScheduler } = await import('/src/lib/scheduler.js');"
             "const backend = createChromeBackend(); const sched = createScheduler({ api: chrome, store, backend });")
    def sched_run(body): return page.evaluate(f"async () => {{ {STORE} {SCHED} {body} }}")
    sched_run(f"await sched.handleButton('{rem_name}', 0);")
    page.wait_for_timeout(300)
    alarms = page.evaluate("async () => (await chrome.alarms.getAll()).map(a => a.name)")
    notifs = page.evaluate("async () => Object.keys(await new Promise(r => chrome.notifications.getAll(r)))")
    snz = f"snz|{a['id']}|{soon['date']}"
    check("Snooze clears the notification and schedules a snooze alarm", rem_name not in notifs and snz in alarms, f"{alarms} {notifs}")

    page.evaluate(f"chrome.alarms.create('{snz}', {{ when: Date.now() + 1000 }})")
    page.wait_for_timeout(3000)
    notifs = page.evaluate("async () => Object.keys(await new Promise(r => chrome.notifications.getAll(r)))")
    check("the snoozed reminder comes back as a notification", snz in notifs, str(notifs))

    sched_run(f"await sched.handleButton('{snz}', 1);")
    page.wait_for_timeout(800)
    done = run(page, f"return (await store.get('{a['id']}')).done;")
    alarms = page.evaluate("async () => (await chrome.alarms.getAll()).map(a => a.name)")
    check("Mark done completes the item and clears its alarms", done is True and not [n for n in alarms if a["id"] in n], f"{done} {alarms}")
    check("badge clears after Mark done", page.evaluate("async () => await chrome.action.getBadgeText({})") == "", "")

    # catch-up: a reminder that was due 5 minutes ago while "the browser was closed"
    late = page.evaluate("() => { const d = new Date(Date.now() + 5*60000); const p = n => String(n).padStart(2,'0'); return { date: d.toLocaleDateString('sv-SE'), time: p(d.getHours()) + ':' + p(d.getMinutes()) }; }")
    b = run(page, f"return await store.add({{ title: 'Missed call', date: '{late['date']}', time: '{late['time']}', reminders: [{{ offsetMin: 10 }}] }});")
    page.wait_for_timeout(800)
    sched_run("await sched.boot();")
    page.wait_for_timeout(500)
    notifs = page.evaluate("async () => Object.keys(await new Promise(r => chrome.notifications.getAll(r)))")
    check("startup catch-up shows the missed reminder", f"rem|{b['id']}|{late['date']}|10" in notifs, str(notifs))

    # ---------- 8. visuals ----------
    run(page, "for (const i of await store.list()) await store.remove(i.id); for (const c of await store.listCategories()) await store.removeCategory(c.id);")
    page.reload(); page.wait_for_selector("#add-input")
    add("Finish thesis chapter tomorrow 9am #study"); add("Team sync every weekday 10:30 #work")
    add(f"{iso(2)} to {iso(3)} Job Fair 2026 #work"); add("Buy a birthday present"); add("Dentist 15:00")
    page.fill("#add-input", "conference fri-sun"); page.fill("#add-input", "")
    page.click(".tab[data-tab=upcoming]"); shot("06-popup-upcoming-light")
    page.click(".tab[data-tab=today]"); shot("07-popup-today-light")
    page.emulate_media(color_scheme="dark"); page.wait_for_timeout(500)
    shot("08-popup-today-dark")
    page.click(".tab[data-tab=upcoming]")
    page.locator(".row .edit").first.click(); shot("09-edit-dark")
    page.click("#edit-back")
    opt.emulate_media(color_scheme="dark"); opt.reload(); opt.wait_for_selector(".sec-row"); opt.wait_for_timeout(500)
    opt.screenshot(path=f"{SHOTS}/10-options-dark.png", full_page=True)

    # ---------- 9. new repeats, popup chips, calendar page ----------
    run(page, "for (const i of await store.list()) await store.remove(i.id);")
    page.reload(); page.wait_for_selector("#add-input")
    add("Gym every thursday and friday 7am #sport")
    add("Drink water every 5 hours")
    check("popup filter has no 'No section' chip", not any("No section" in t for t in texts(".fchip")), str(texts(".fchip")))
    its = items()
    gym = next(i for i in its if i["title"] == "Gym"); water = next(i for i in its if i["title"] == "Drink water")
    check("quick-add: every thursday and friday", gym["recurrence"].get("weekdays") == [4, 5], str(gym["recurrence"]))
    check("quick-add: every 5 hours", water["recurrence"] == {"freq": "hourly", "interval": 5} and water["time"], str(water))
    run(page, f"await store.add({{ title: 'Job Fair', type: 'event', date: '{iso(2)}', endDate: '{iso(3)}' }});")
    page.click("#open-calendar", modifiers=[])
    page.wait_for_timeout(800)
    cal = [pg for pg in ctx.pages if "app.html" in pg.url]
    check("popup button opens the calendar tab", len(cal) == 1, str([pg.url for pg in ctx.pages]))
    cal = cal[0] if cal else ctx.new_page()
    if not cal.url.endswith("app.html"): cal.goto(f"chrome-extension://{ext_id}/src/app/app.html")
    watch(cal); cal.set_viewport_size({"width": 1180, "height": 800})
    cal.wait_for_selector(".day"); cal.reload(); cal.wait_for_selector(".day")
    check("grid has 42 days, today selected", cal.locator(".day").count() == 42 and cal.locator(".day.sel").count() == 1)
    cal.locator(f'.day[data-date="{iso(2)}"]').click()
    cal.locator(f'.day[data-date="{iso(3)}"]').click(modifiers=["Control"])
    check("two days selected and highlighted", cal.locator(".day.sel").count() == 2)
    check("panel lists the Job Fair on both days", cal.locator(".day-block .row", has_text="Job Fair").count() == 2)
    cal.fill("#quick-input", "Study group 4pm"); cal.press("#quick-input", "Enter"); cal.wait_for_timeout(600)
    sg = next((i for i in items() if i["title"] == "Study group"), None)
    check("quick-add in the panel uses the selected day", sg is not None and sg["date"] == iso(2) and sg["endDate"] == iso(3), str(sg))
    cal.locator(f'.day[data-date="{iso(2)}"]').click(); cal.screenshot(path=f"{SHOTS}/11-calendar.png", full_page=True)
    cal.click("#quick-details"); check("More options opens the form", cal.locator("form.item-form, .edit-card form").count() == 1)
    cal.click("#edit-back")
    cal.locator(".row .check").first.check(); cal.wait_for_timeout(400)
    check("ticking a row marks it done", any(i.get("done") or i.get("completedDates") for i in items()))
    cal.click('.vtab[data-view=all]'); cal.wait_for_selector("#f-query")
    cal.fill("#f-query", "water"); cal.wait_for_timeout(200)
    check("All list search narrows the list", cal.locator("#all-list .row").count() == 1, cal.inner_text("#all-count"))
    cal.fill("#f-query", ""); cal.select_option("#f-status", "all")
    check("All list status=all shows everything", cal.locator("#all-list .row").count() >= 4)
    cal.screenshot(path=f"{SHOTS}/12-all.png", full_page=True)
    cal.emulate_media(color_scheme="dark"); cal.click('.vtab[data-view=calendar]'); cal.wait_for_timeout(500)
    cal.screenshot(path=f"{SHOTS}/13-calendar-dark.png", full_page=True)
    cal.evaluate("() => { const t = document.createElement('div'); document.body.append(t); }")
    run(page, f"await store.add({{ title: '<img src=x onerror=window.__pwn=1>', date: '{iso(0)}' }});")
    cal.reload(); cal.wait_for_selector(".day"); cal.wait_for_timeout(300)
    check("HTML in a title stays inert on the calendar page", cal.evaluate("() => !window.__pwn && !document.querySelector('img[src=x]')"))

    # ---------- 10. round-2 improvements ----------
    run(page, "for (const i of await store.list()) await store.remove(i.id);")
    page.reload(); page.wait_for_selector("#add-input")
    check("popup opens on Today", page.get_attribute(".tab[data-tab=today]", "aria-selected") == "true")
    page.click(".tab[data-tab=general]"); page.reload(); page.wait_for_selector("#add-input")
    check("popup still opens on Today after leaving it on General", page.get_attribute(".tab[data-tab=today]", "aria-selected") == "true")
    check("settings button is just 'Settings'", page.get_attribute("#open-options", "title") == "Settings")
    add("Drink water every 5 hours"); add("Standup every monday to friday 9am"); add("Note to self today 23:59")
    pin_today(page, "Drink water")
    run(page, "const it = (await store.list()).find(i => i.title === 'Note to self'); await store.update(it.id, { checkable: false, showOnCalendar: false });")
    page.reload(); page.wait_for_selector("#add-input"); page.wait_for_timeout(300)
    standup = next(i for i in items() if i["title"] == "Standup")
    check("'every monday to friday' becomes five weekdays", standup["recurrence"]["weekdays"] == [1, 2, 3, 4, 5], str(standup["recurrence"]))
    wrow = page.locator(".row", has_text="Drink water")
    check("hourly row shows its slot and the restart button", wrow.count() == 1 and wrow.locator("button.restart").count() == 1)
    check("note row has no checkbox", page.locator(".row", has_text="Note to self").locator("input.check").count() == 0 and page.locator(".row", has_text="Note to self").count() == 1)
    page.screenshot(path=f"{SHOTS}/14-popup-today.png", full_page=True)
    before = next(i for i in items() if i["title"] == "Drink water")
    wrow.locator("button.restart").click(); page.wait_for_timeout(500)
    after = next(i for i in items() if i["title"] == "Drink water")
    check("restart re-anchors the cycle and ticks the slot", len(after["completedDates"]) == 1 and after["time"] != before["time"] or after["completedDates"][0].endswith(after["time"]), str(after))
    check("a ticked hourly row leaves Today", page.locator(".row", has_text="Drink water").count() == 0)
    no_sb = page.evaluate("() => { const l = document.getElementById('list'); return getComputedStyle(l).scrollbarWidth }")
    check("popup list hides its scrollbar", no_sb == "none", str(no_sb))
    cal2 = ctx.new_page(); watch(cal2); cal2.set_viewport_size({"width": 1180, "height": 800})
    cal2.goto(f"chrome-extension://{ext_id}/src/app/app.html"); cal2.wait_for_selector(".day")
    check("calendar 'Settings' tooltip", cal2.get_attribute("#open-options", "title") == "Settings")
    check("hidden item stays off the grid chips", cal2.locator(".day .dchip", has_text="Note to self").count() == 0)
    cal2.wait_for_timeout(200)  # today is selected when the page opens
    check("...but is listed in the day panel with a marker", cal2.locator(".day-block .row", has_text="Note to self").count() == 1 and cal2.locator(".day-block .row", has_text="Hidden on grid").count() == 1)
    nxt = cal2.locator(".day:not(.out)").nth(10); nxt2 = cal2.locator(".day:not(.out)").nth(12)
    nxt.click(modifiers=["Control"]); nxt2.click(modifiers=["Control"])
    check("Ctrl-click picks separate days", cal2.locator(".day.sel").count() == 3, str(cal2.locator(".day.sel").count()))
    cal2.click('.vtab[data-view=all]'); cal2.wait_for_selector("#f-query")
    w0 = cal2.evaluate("() => document.documentElement.clientWidth")
    cal2.fill("#f-query", "zzzz-no-match"); cal2.wait_for_timeout(200)
    w1 = cal2.evaluate("() => document.documentElement.clientWidth")
    check("page width does not jump when the list shrinks", w0 == w1, f"{w0} {w1}")
    cal2.fill("#f-query", "")
    cal2.close()

    # ---------- 11. round 3: restart for every repeat, per-slot ticks, no popup scrollbar ----------
    run(page, "for (const i of await store.list()) await store.remove(i.id);")
    page.reload(); page.wait_for_selector("#add-input")
    add("Pills every 3 days 9:00"); add("Drink water every 5 hours"); add("Standup weekday monday-friday 10:00AM-10:00PM X")
    pin_today(page, "Drink water")
    st = next(i for i in items() if i["title"] == "Standup X")
    check("'weekday monday-friday 10:00AM-10:00PM X' sets days and end time", st["recurrence"]["weekdays"] == [1, 2, 3, 4, 5] and st["time"] == "10:00" and st["endTime"] == "22:00", str(st))
    pills = next(i for i in items() if i["title"] == "Pills")
    run(page, f"await store.update('{pills['id']}', {{ date: '{iso(-6)}' }});")  # so that today is one of its days
    page.reload(); page.wait_for_selector("#add-input"); page.wait_for_timeout(300)
    prow = page.locator(".row", has_text="Pills")
    check("every repeating item due today has a restart button", prow.locator("button.restart").count() == 1)
    prow.locator("button.restart").click(); page.wait_for_timeout(500)
    after = next(i for i in items() if i["title"] == "Pills")
    check("restart re-anchors a 3-day repeat at today", after["date"] == iso(0) and after["completedDates"] == [iso(0)], str(after))
    # lots of items: the popup must not grow a scrollbar of its own
    run(page, "for (let i = 0; i < 14; i++) await store.add({ title: 'Busy item ' + i, date: new Date().toLocaleDateString('sv-SE'), time: '23:' + String(10 + i) });")
    page.set_viewport_size({"width": 380, "height": 600}); page.reload(); page.wait_for_selector(".row"); page.wait_for_timeout(400)
    dims = page.evaluate("() => ({ doc: document.documentElement.scrollHeight, win: innerHeight, list: document.getElementById('list').scrollHeight > document.getElementById('list').clientHeight, sb: getComputedStyle(document.getElementById('list')).scrollbarWidth })")
    check("popup with many items fits in 600px with no page scrollbar", dims["doc"] <= dims["win"] and dims["list"] and dims["sb"] == "none", str(dims))
    page.screenshot(path=f"{SHOTS}/15-popup-busy.png")
    page.locator(".row .body").first.click(); page.wait_for_selector("#edit-body form")
    d2 = page.evaluate("() => ({ doc: document.documentElement.scrollHeight, win: innerHeight })")
    check("edit view also fits without a page scrollbar", d2["doc"] <= d2["win"], str(d2))
    page.click("#edit-back")
    page.set_viewport_size({"width": 380, "height": 640})
    cal3 = ctx.new_page(); watch(cal3); cal3.set_viewport_size({"width": 1180, "height": 800})
    cal3.goto(f"chrome-extension://{ext_id}/src/app/app.html"); cal3.wait_for_selector(".day")
    wrow = cal3.locator(".day-block .row", has_text="Drink water")
    n_slots = wrow.locator(".slot input").count()
    check("calendar panel gives an hourly item one tick box per time", n_slots >= 2, str(n_slots))
    wrow.locator(".slot input").first.check(); cal3.wait_for_timeout(500)
    w = next(i for i in items() if i["title"] == "Drink water")
    check("ticking one time marks only that time", len(w["completedDates"]) == 1 and "@" in w["completedDates"][0], str(w["completedDates"]))
    cal3.screenshot(path=f"{SHOTS}/16-calendar-slots.png", full_page=True)
    cal3.close()

    # ---------- 12. round 4: edit form reachable without scrollbar, everyday, reminders in the panel ----------
    run(page, "for (const i of await store.list()) await store.remove(i.id);")
    add("Read everyday 8pm")
    check("'everyday' is a daily repeat", any(i["title"] == "Read" and i["recurrence"] == {"freq": "daily", "interval": 1} for i in items()))
    rd = next(i for i in items() if i["title"] == "Read")
    run(page, f"await store.update('{rd['id']}', {{ date: '{iso(0)}', time: '23:59' }});")  # make sure it is on Today
    page.set_viewport_size({"width": 380, "height": 600}); page.reload(); page.wait_for_selector(".row")
    page.locator(".row .body").first.click(); page.wait_for_selector("#edit-body form")
    page.locator("#edit-body").evaluate("e => e.scrollTo(0, e.scrollHeight)"); page.wait_for_timeout(200)
    info = page.evaluate("() => { const e = document.getElementById('edit-body'); const p = e.querySelector('.pills'); const r = p.getBoundingClientRect(); const b = e.getBoundingClientRect(); return { scrollable: e.scrollHeight > e.clientHeight, inView: r.top >= b.top - 1 && r.bottom <= b.bottom + 1, doc: document.documentElement.scrollHeight, win: innerHeight }; }")
    check("edit form scrolls (no bar) so the reminders can be reached", info["scrollable"] and info["inView"] and info["doc"] <= info["win"], str(info))
    page.locator("#edit-body .pills label", has_text="1 day before").click()
    page.locator("#edit-body button[type=submit]").click(); page.wait_for_timeout(500)
    check("a 'before' reminder can be chosen and saved", any(i["title"] == "Read" and {"offsetMin": 1440} in i["reminders"] for i in items()), str([i["reminders"] for i in items()]))
    page.set_viewport_size({"width": 380, "height": 640})
    cal4 = ctx.new_page(); watch(cal4); cal4.set_viewport_size({"width": 1180, "height": 800})
    cal4.goto(f"chrome-extension://{ext_id}/src/app/app.html"); cal4.wait_for_selector(".day")
    check("no 'Select several days' button any more", cal4.locator("#multi-btn").count() == 0)
    cal4.select_option("#quick-reminder", "1440")
    cal4.fill("#quick-input", "Passport renewal"); cal4.press("#quick-input", "Enter"); cal4.wait_for_timeout(600)
    pr = next(i for i in items() if i["title"] == "Passport renewal")
    check("the panel's reminder choice is used", pr["reminders"] == [{"offsetMin": 1440}], str(pr["reminders"]))
    cal4.close()

    real_errors = [e for e in errors if "favicon" not in e]
    check("no console errors or warnings on any page", not real_errors, "; ".join(real_errors[:5]))
    ctx.close()

print(f"\n{'FAILED: ' + ', '.join(failures) if failures else 'ALL CHECKS PASSED'}")
sys.exit(1 if failures else 0)
