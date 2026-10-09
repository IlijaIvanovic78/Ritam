// Engleski katalog — IZVOR ISTINE za ključeve prevoda. sr.ts mora imati tačno iste ključeve (TypeScript to
// proverava: `satisfies Record<MessageKey, string>`). Engleski je podrazumevani jezik, srpski je dodatni.
//
// ---- Ključevi ----
// Ravni ključevi sa tačkama, prvi deo je oblast (ekran ili deo aplikacije):
//   common.*    zajedničke reči i dugmad (Save, Cancel, Delete, Close, Today…), množine (common.blocks…)
//   status.*    statusi bloka (Done / Partial / Not done / Pending)
//   error.*     opšte greške na klijentu (mreža, server); greške sa servera stižu već prevedene
//   lang.*      nazivi jezika (uvek na svom jeziku: "English", "Srpski")
//   day.*       stranica Danas (zaglavlje, kartica Sada, vremenska linija, sheet bloka, Pregled, šabloni dana)
//   tasks.*     kartica Zadaci i sheet zadatka
//   notes.*     kartica Beleške (draftovi, sukob, ocena dana)
//   progress.*  Napredak          journal.*   Dnevnik          schedule.*  Raspored (kategorije, šabloni, dani)
//   settings.*  Podešavanja       login.*     Prijava / Napravi nalog
//   shell.*     okvir (navigacija, naslovi stranica, traka "nema interneta", greška stranice, 404)
//   ui.*        zajedničke komponente iz web/src/ui (Sheet, toast, potvrda, ocena…)
//   update.*    traka nove verzije
// Posle oblasti ide deo ekrana pa značenje: 'day.now.next', 'schedule.category.deleteTitle',
// 'settings.account.signOut'. Ključ opisuje značenje, ne tekst (ne 'day.saveButton2'). Ponovo koristi common.*
// kad je tekst isti po smislu; kad isti engleski tekst na srpskom zavisi od mesta, napravi poseban ključ.
//
// ---- Poruke ----
// - {ime} se zamenjuje parametrom: t('day.now.next', { title, time }). TypeScript traži tačno te parametre.
// - Množina: oblici razdvojeni sa "|" i parametar `n` (broj): en "one|other" ('{n} block|{n} blocks'),
//   sr "one|few|other" ('{n} blok|{n} bloka|{n} blokova'; few = 2–4 osim 12–14). t('common.blocks', { n: 3 }).
//   {n} se ispisuje kako je dat; decimalan broj (2,5) prosledi i kao poseban parametar (fmtDecimal iz shared/time.ts).
// - Datumi i brojevi nisu u katalogu: fmtDateLong / fmtDateMedium / fmtDateShort / fmtMonthYear / fmtDayMonth /
//   fmtDateRange / weekdayName (posle srpskog "za": weekdayNameAcc) / weekdayShort / monthName / fmtDecimal iz
//   shared/time.ts, uvek sa jezikom (`useLang()`). Nabrajanje "a, b and c" / "a, b i c": joinAnd iz './index.ts'.
//   Vreme "09:15" (fmtClock), trajanje "4h 45m" (fmtDuration) i "73%" (fmtPercent) su isti u oba jezika.
// - U komponenti: `const t = useT();` (ponovo se renderuje kad se promeni jezik). Van Reacta (lib, toast iz
//   pomoćne funkcije): `t()` iz './index.ts' — trenutni jezik. Tekst izračunat u useMemo/useCallback mora imati
//   jezik u zavisnostima (`const lang = useLang()`).
//
// ---- Engleski tekst ----
// Kratko i jasno, rečenice malim slovom osim prve reči (sentence case: "Add block", ne "Add Block"), bez
// uzvičnika i emodžija, bez marketinškog tona; obraćanje direktno ("you"). Tipografski apostrof i navodnici
// (’ “ ”), tri tačke kao jedan znak (…). Pojmovi (EN ↔ SR):
//   Block / Blocks ↔ Blok / Blokovi (nikad "cube"/"kocka")   Template ↔ Šablon      Category ↔ Kategorija
//   Today ↔ Danas   Progress ↔ Napredak   Journal ↔ Dnevnik   Schedule ↔ Raspored   Settings ↔ Podešavanja
//   Tasks ↔ Zadaci   Notes ↔ Beleške   Now ↔ Sada   Overview ↔ Pregled   Free time ↔ Slobodno vreme
//   Days of the week ↔ Dani u nedelji (ne "Weekdays": na engleskom je to samo pon–pet, i "this day of the week",
//   ne "this weekday")   Planned per week ↔ Planirano nedeljno   Day starts at ↔ Dan počinje u
//   completion ↔ ispunjenost ("counts toward completion" ↔ "računa se u ispunjenost")   streak ↔ niz dana
//   rate a block ↔ oceni blok   Done / Partial / Not done / Pending ↔ Urađeno / Delimično / Nije urađeno / Čeka
//   Backup ↔ Rezervna kopija   Account ↔ Nalog   Sign in ↔ Prijavi se   Create account ↔ Napravi nalog
//   Sign out ↔ Odjavi se   Language ↔ Jezik
// Srpski (sr.ts): latinica, obraćanje na "ti", isti tekst kao pre prevoda (pažljivo pregledan) — ne menja se
// bez razloga.

export const en = {
  // ---- Jezik ----
  'lang.en': 'English',
  'lang.sr': 'Srpski',
  /** Oznaka izbora jezika — čitljiva na oba jezika. */
  'lang.label': 'Language · Jezik',

  // ---- Zajedničko ----
  'common.save': 'Save',
  'common.saving': 'Saving…',
  'common.saved': 'Saved',
  'common.cancel': 'Cancel',
  'common.delete': 'Delete',
  'common.close': 'Close',
  'common.add': 'Add',
  'common.edit': 'Edit',
  'common.back': 'Back',
  'common.retry': 'Try again',
  'common.reload': 'Reload',
  'common.today': 'Today',
  'common.yesterday': 'Yesterday',
  'common.tomorrow': 'Tomorrow',
  'common.noCategory': 'No category',
  /** Obrisana kategorija koju sačuvani blokovi i zadaci i dalje imaju (nova može imati isti naziv). */
  'common.deletedCategory': '{name} (deleted)',
  'common.blocks': '{n} block|{n} blocks',
  'common.tasks': '{n} task|{n} tasks',
  'common.days': '{n} day|{n} days',
  /** Poslednja stavka nabrajanja (joinAnd): "Monday, Tuesday and Friday", "Oct 6 and Oct 8". */
  'common.listAnd': '{rest} and {last}',
  /** Opseg vremena bloka koji se završava sledećeg dana: "23:30–09:00 the next day" (i u šablonu, i za prošle dane). */
  'common.rangeNextDay': '{range} the next day',
  /** Izmena početka prebacuje blok na kraj dana (sheet bloka i editor šablona). */
  'common.blockJumpToEnd': 'The block moves to the end of this day ({range}). Time before {dayStart} belongs to the previous day.',
  /** Izmena početka prebacuje blok na početak dana. */
  'common.blockJumpToStart':
    'The block moves to the start of this day ({range}) because the day starts at {dayStart}. To keep a block after midnight at the end of the day, change “Day starts at” in Settings.',

  // ---- Status bloka ----
  'status.done': 'Done',
  'status.partial': 'Partial',
  'status.skipped': 'Not done',
  /** Kratka oznaka u izboru statusa (sheet bloka). */
  'status.skippedShort': 'Not done',
  'status.pending': 'Pending',
  'status.pendingHint': 'Not rated yet',

  // ---- Greške na klijentu ----
  'error.generic': 'Something went wrong. Try again.',
  'error.network': 'No connection to the server.',
  'error.timeout': 'The server isn’t responding. Try again.',
  'error.unavailable': 'The server is unavailable. Try again.',
  'error.server': 'Server error ({status}).',
  'error.offline': 'No connection.',
  'error.notSignedIn': 'You’re not signed in.',

  // ---- Danas (pages/DayPage.tsx, components/day/*): zaglavlje, Sada, Blokovi, sheet bloka, Pregled, šabloni ----
  'day.addBlock': 'Add block',
  'day.loadError': 'Couldn’t load the day.',
  /** Blok iz pregleda: dan je upisan iz šablona, a plan se u međuvremenu promenio (drugi uređaj, drugi šablon). */
  'day.planChanged': 'The plan changed in the meantime — check the blocks.',
  /** Oznaka trenutnog bloka i praznine u vremenskoj liniji. */
  'day.nowTag': 'now',
  'day.header.pickDate': 'Choose date',
  'day.header.prevDay': 'Previous day',
  'day.header.nextDay': 'Next day',
  /** Relativni dan u podnaslovu (na telefonu malim slovom: "3 days ago"); juče/sutra su common.*. */
  'day.header.daysAgo': '{n} day ago|{n} days ago',
  'day.header.inDays': 'In {n} day|In {n} days',
  'day.menu.label': 'More options',
  'day.menu.applyOtherTemplate': 'Apply another template…',
  'day.menu.resetToTemplate': 'Reset to template',
  'day.menu.goToDate': 'Go to date…',
  'day.template.apply': 'Apply',
  'day.template.clear': 'Clear',
  'day.template.clearTitle': 'Clear this day?',
  'day.template.applyTitle': 'Apply template?',
  'day.template.applyNamedTitle': 'Apply template “{name}”?',
  'day.template.progressLost': 'This day’s blocks, their statuses and notes will be deleted.',
  /** {blocks} = common.blocks ("3 blocks"). */
  'day.template.clearBody': 'This day’s blocks ({blocks}) will be deleted.',
  'day.template.replaceBody': 'This day’s blocks ({blocks}) will be replaced with the template’s blocks.',
  'day.reset.title': 'Reset the day to its template?',
  'day.reset.body': 'The blocks will be replaced with the blocks from template “{name}”. Block statuses and notes will be deleted.',
  'day.reset.bodyNoTemplate':
    'There’s no template for this day of the week, so the day will have no blocks. Block statuses and notes will be deleted.',
  'day.reset.confirm': 'Reset',
  'day.picker.title': 'Apply template',
  'day.picker.lead': 'The chosen template replaces the blocks for this day only. Your schedule stays the same.',
  'day.picker.current': 'current',
  'day.picker.empty': 'Empty day',
  'day.picker.emptyHint': 'No blocks — you add them yourself.',
  'day.welcome.title': 'Set up your schedule',
  'day.welcome.lead': 'Describe your day once, and Ritam will lay it out for you every day.',
  'day.welcome.categoriesTitle': 'Categories',
  'day.welcome.categoriesText': 'the things you do and their colors',
  'day.welcome.templateTitle': 'Template',
  'day.welcome.templateText': 'a day plan with blocks and times',
  'day.welcome.weekdaysTitle': 'Days of the week',
  'day.welcome.weekdaysText': 'which template applies on which day',
  /** Za čitač ekrana, posle urađenog koraka. */
  'day.welcome.stepDone': '(done)',
  'day.welcome.setUp': 'Set up schedule',
  'day.welcome.addToday': 'Add a block just for today',
  'day.welcome.addThisDay': 'Add a block just for this day',
  'day.now.label': 'Now',
  /** Preostalo vreme; {time} je istaknut ("1h 12m left" / "još 1h 12m"). */
  'day.now.left': '{time} left',
  'day.now.elapsed': 'Time elapsed in this block',
  'day.now.fromYesterday': 'from yesterday',
  'day.now.free': 'Free time',
  'day.now.over': 'The day is over — rate your blocks and write down your thoughts.',
  'day.now.next': 'Next:',
  /** Posle naslova sledećeg bloka; {time} je istaknut. */
  'day.now.nextAt': 'at {time}',
  'day.now.nextTitle': '{title} at {time}',
  'day.now.due': '{n} block needs rating|{n} blocks need rating',
  'day.now.yesterdayDue': 'Yesterday: {n} block needs rating|Yesterday: {n} blocks need rating',
  'day.timeline.title': 'Blocks',
  'day.timeline.preparing': 'Preparing the day…',
  'day.timeline.untrackedTemplate':
    'This day wasn’t tracked. This is the plan from template “{name}” — rate a block to start tracking the day.',
  'day.timeline.untrackedNoTemplate': 'This day wasn’t tracked. There’s no template for this day of the week.',
  'day.timeline.previewTemplate': 'Planned from template “{name}” — changes apply to this day only.',
  'day.timeline.previewNoTemplate': 'There’s no template for this day of the week. Add blocks as you like.',
  /** {day} = dan u nedelji posle "za" (weekdayNameAcc: "Saturday" / "subotu"). */
  'day.timeline.weekdayOffer': 'The template for {day} is “{name}”, but this day was created without a template.',
  'day.timeline.empty': 'No plan for this day.',
  'day.timeline.applyTemplate': 'Apply template…',
  /** Praznina između blokova: "free · 1h". */
  'day.timeline.gap': 'free · {time}',
  'day.row.actual': 'actual {time}',
  'day.row.noteTooltip': 'Has a note',
  /** Isto, za čitač ekrana (usred reda, malim slovom). */
  'day.row.noteLabel': 'has a note',
  'day.row.due': 'needs rating',
  'day.row.statusLabel': 'Status: {title}',
  'day.block.newTitle': 'New block',
  'day.block.editTitle': 'Edit block',
  'day.block.deletedElsewhere': 'This block was deleted on another device.',
  'day.block.changedElsewhere':
    'This block was changed on another device. Saving only changes the fields you edited here.',
  'day.block.titleLabel': 'Title',
  'day.block.titlePlaceholder': 'Block name',
  'day.block.titleRequired': 'Enter a block title.',
  'day.block.category': 'Category',
  'day.block.from': 'From',
  'day.block.to': 'To',
  'day.block.timeRequired': 'Enter a start and end time.',
  'day.block.timeSame': 'Start and end can’t be the same.',
  'day.block.timeInvalid': 'Invalid time.',
  'day.block.duration': 'Duration {time}',
  'day.block.afterMidnight': 'after midnight',
  /** {hint} = trajanje ("Duration 8h · after midnight"). */
  'day.block.lateWarn': '{hint}. The block is placed at the end of this day, after midnight.',
  'day.block.status': 'Status',
  'day.block.statusAria': 'Block status',
  'day.block.actualLabel': 'Actual time (min)',
  'day.block.actualInvalid': 'Enter a number of minutes (0–1440).',
  'day.block.actualMax': 'At most {max} min (the block’s length).',
  'day.block.actualDefaultDone': 'Empty = whole block ({time})',
  'day.block.actualDefaultPartial': 'Empty = half the block ({time})',
  'day.block.note': 'Note',
  'day.block.notePlaceholder': 'How did it go, what was missing…',
  'day.block.deleteTitle': 'Delete block?',
  'day.block.deleteBody': '“{title}” will be removed from this day.',
  'day.block.swapped': 'Swapped.',
  'day.split.open': 'Split',
  'day.split.hint': 'Split the block in two',
  'day.split.tooShortHint': 'The block is too short to split',
  'day.split.confirm': 'Split block',
  'day.split.at': 'Split at',
  /** Dva dela posle deljenja: "09:00–10:30 and 10:30–12:00". */
  'day.split.parts': '{first} and {second}',
  'day.split.note': 'The second part gets the same title and category, without a status or note.',
  'day.split.timeRequired': 'Enter a time.',
  'day.split.outside': 'Choose a time between {start} and {end}.',
  'day.split.invalid': 'Invalid split point.',
  'day.split.tooShort': 'Both parts need at least 5 minutes.',
  'day.swap.label': 'Swap with…',
  'day.swap.hint': 'Swap title and category with another block',
  'day.swap.aria': 'Swap title and category with block',
  'day.summary.title': 'Overview',
  'day.summary.scoreAria': 'Completion {pct}',
  /** Istaknut je deo od {done} do {n} ("5 / 11"), pa {done} mora biti ispred {n}. */
  'day.summary.done': '{done} / {n} block done|{done} / {n} blocks done',
  'day.summary.pending': '{count} pending',
  'day.summary.categoryAria': '{name}: {done} of {planned}',

  // ---- Zadaci (components/day/TasksCard.tsx, TaskSheet.tsx) ----
  'tasks.title': 'Tasks',
  'tasks.countAria': '{done} of {total} done',
  'tasks.carry.text': 'You have {n} unfinished task from earlier.|You have {n} unfinished tasks from earlier.',
  'tasks.carry.action': 'Move to today',
  'tasks.add.placeholder': 'Add a task',
  'tasks.add.aria': 'New task',
  'tasks.add.button': 'Add task',
  'tasks.empty': 'No tasks for this day.',
  'tasks.editAria': 'Edit: {title}',
  /** Otvoren sheet zadatka se zatvara jer zadatka više nema na ovom danu. */
  'tasks.goneElsewhere': 'This task was changed or deleted on another device.',
  'tasks.sheet.editTitle': 'Edit task',
  'tasks.sheet.changedElsewhere':
    'This task was changed on another device. Saving only changes the fields you edited here.',
  'tasks.sheet.titleLabel': 'Title',
  'tasks.sheet.titleRequired': 'Enter a task title.',
  'tasks.sheet.category': 'Category',
  'tasks.sheet.date': 'Date',
  'tasks.sheet.dateAria': 'Task date: {date}',
  'tasks.sheet.dateNone': 'not selected',
  'tasks.sheet.pickDate': 'Choose a date',
  'tasks.sheet.dateRequired': 'Choose a date.',
  'tasks.sheet.dateHint': 'Changing the date moves the task to that day.',
  'tasks.sheet.movedToday': 'Task moved to today.',
  'tasks.sheet.movedTomorrow': 'Task moved to tomorrow.',
  'tasks.sheet.movedTo': 'Task moved to {date}.',
  'tasks.sheet.deleteTitle': 'Delete task?',
  'tasks.sheet.deleteBody': '“{title}” will be permanently deleted.',
  /** {time} je istaknut (tabularne cifre). */
  'tasks.sheet.doneAt': 'Completed on {date} at {time}',

  // ---- Beleške (components/day/NotesCard.tsx) ----
  'notes.title': 'Notes and thoughts',
  'notes.placeholder': 'How did the day go, what’s on your mind…',
  'notes.notSaved': 'Not saved',
  /** Posle teksta idu linkovi na datume: "Unsaved note for Thu, Oct 8"; više dana: notes.otherDraftsMany. */
  'notes.otherDrafts': 'Unsaved note for',
  'notes.otherDraftsMany': 'Unsaved notes for',
  'notes.conflict': 'This note was changed on another device.',
  /** Sukob: sačuvaj tekst sa ovog uređaja preko verzije sa drugog / odbaci ga i uzmi verziju sa drugog uređaja. */
  'notes.keepMine': 'Save this version',
  'notes.takeTheirs': 'Use the other version',
  'notes.stored': 'An unsaved version of this note was left on this device.',
  'notes.restore': 'Restore it',
  'notes.discard': 'Discard',
  'notes.rating': 'How was the day?',

  // ---- Napredak (pages/ProgressPage.tsx, components/progress/*) ----
  'progress.title': 'Progress',
  /** Oznaka prekidača Nedelja / Mesec (čitač ekrana). */
  'progress.mode.label': 'Period',
  'progress.mode.week': 'Week',
  'progress.mode.month': 'Month',
  'progress.nav.prevWeek': 'Previous week',
  'progress.nav.prevMonth': 'Previous month',
  'progress.nav.nextWeek': 'Next week',
  'progress.nav.nextMonth': 'Next month',
  /** Povratak na tekući period. */
  'progress.nav.thisWeek': 'This week',
  'progress.nav.thisMonth': 'This month',
  /** Ispod naslova perioda; n = broj dana u periodu do danas. */
  'progress.tracked': '{tracked} of {n} day tracked|{tracked} of {n} days tracked',
  'progress.loadError': 'Couldn’t load statistics.',
  'progress.empty.newTitle': 'No tracked days yet.',
  'progress.empty.newText': 'Set up a schedule, then rate blocks on the Today page — your progress will show up here.',
  'progress.empty.setUpSchedule': 'Set up schedule',
  'progress.empty.periodTitleCurrent': 'No tracked days in this period yet.',
  'progress.empty.periodTitlePast': 'No tracked days in this period.',
  'progress.empty.periodText': 'Rate blocks on the Today page and your progress will show up here.',
  'progress.kpi.completion': 'Completion',
  /** Ispod proseka ispunjenosti i ocene dana. */
  'progress.kpi.average': 'average over {n} day|average over {n} days',
  'progress.kpi.todayLive': 'today is in progress',
  'progress.kpi.noTrackedDays': 'no tracked days',
  'progress.kpi.streak': 'Streak',
  'progress.kpi.threshold': 'threshold {pct}%',
  /** Niz na kraju završenog perioda: "as of Oct 5". */
  'progress.kpi.asOf': 'as of {date}',
  'progress.kpi.tasks': 'Tasks',
  /** pct je već formatiran ("73%"). */
  'progress.kpi.tasksDone': '{pct} done',
  'progress.kpi.noTasks': 'no tasks',
  'progress.kpi.rating': 'Day rating',
  'progress.kpi.noRatings': 'no ratings',
  'progress.byDay.title': 'Completion by day',
  /** Kalendar meseca (čitač ekrana). */
  'progress.byDay.monthLabel': 'Completion by day for the month',
  /** Opis grafika nedelje za čitač ekrana; days = "Mon 80%, Tue not tracked, …". */
  'progress.week.summary': '{days}. Streak threshold is {pct}%.',
  /** Budući dan u opisu grafika nedelje: "Sat upcoming". */
  'progress.week.upcoming': '{day} upcoming',
  'progress.categories.title': 'By category',
  'progress.categories.empty': 'No planned blocks in this period.',
  'progress.categories.notCounted': 'Doesn’t count toward completion',
  /** "3h 20m of 4h" (urađeno od planiranog vremena). */
  'progress.categories.of': 'of',
  /** Odrađeni blokovi od planiranih; done može biti decimalan ("2.5"). */
  'progress.categories.count': '{done} / {n} block|{done} / {n} blocks',
  'progress.tasks.title': 'Completed tasks',
  'progress.tasks.empty': 'No completed tasks in this period.',
  'progress.tasks.showAll': 'Show all ({count})',
  /** Datum grupe iz druge godine: "Thu, Oct 8, 2025". */
  'progress.tasks.dateWithYear': '{date}, {year}',
  'progress.heatmap.title': 'Last 12 weeks',
  'progress.heatmap.label': 'Completion over the last 12 weeks',
  'progress.heatmap.loadError': 'Couldn’t load. {error}',
  'progress.legend.less': 'less',
  'progress.legend.more': 'more',
  'progress.legend.threshold': 'streak threshold',
  /** Dan bez podataka (tooltip, legenda, opis grafika). */
  'progress.notTracked': 'not tracked',
  /** Danas dok traje i nije dostigao prag za niz (tooltip, legenda, opis grafika). */
  'progress.live': 'in progress',
  /** Delovi tooltipa dana: "Tuesday, October 7: 73% · blocks 5 / 7 (+1 partial) · tasks 2 / 3". */
  'progress.tip.noCounted': 'no blocks that count',
  'progress.tip.blocks': 'blocks {done} / {counted}',
  'progress.tip.blocksPartial': 'blocks {done} / {counted} (+{partial} partial)',
  'progress.tip.tasks': 'tasks {done} / {total}',

  // ---- Dnevnik (pages/JournalPage.tsx) ----
  'journal.title': 'Journal',
  'journal.loadError': 'Couldn’t load the journal.',
  'journal.search.placeholder': 'Search notes',
  'journal.search.clear': 'Clear search',
  'journal.search.noResults': 'Nothing found for “{query}”.',
  /** Čitač ekrana posle pretrage; count je broj, uz "+" ako ima još ("20+"). */
  'journal.search.found': 'Entries found: {count}',
  'journal.empty.title': 'No notes yet.',
  'journal.empty.text': 'Write them on the Today page.',
  'journal.empty.openToday': 'Open Today',
  'journal.loadMore': 'Load more',
  'journal.entry.showMore': 'Show more',
  'journal.entry.showLess': 'Show less',
  /** pct je već formatiran ("73%"). */
  'journal.meta.score': '{pct} complete',
  'journal.meta.scoreTitle': 'Block completion',
  /** Urađeni od ukupno zadataka dana: "3/5 tasks". */
  'journal.meta.tasks': '{done}/{n} task|{done}/{n} tasks',
  'journal.meta.tasksTitle': 'Tasks done',

  // ---- Raspored: kategorija napravljena u hodu (lib/categories.ts) i paleta boja (lib/palette.ts) ----
  'schedule.categoryInline.reused': 'A category with that name already exists — it’s selected.',
  'schedule.categoryInline.created': 'Category added. It counts toward completion (change this in Schedule).',
  'schedule.palette.slateBlue': 'Slate blue',
  'schedule.palette.teal': 'Teal',
  'schedule.palette.blue': 'Blue',
  'schedule.palette.purple': 'Purple',
  'schedule.palette.orange': 'Orange',
  'schedule.palette.green': 'Green',
  'schedule.palette.ochre': 'Ochre',
  'schedule.palette.red': 'Red',
  'schedule.palette.brown': 'Brown',
  'schedule.palette.gray': 'Gray',

  // ---- Podešavanja: jezik ----
  'settings.language.hint': 'Applies to all your devices.',
  /** Čuvanje jezika na nalogu nije uspelo; jezik je vraćen, poruka je na vraćenom jeziku. */
  'settings.language.saveFailed': 'Language wasn’t saved. Try again.',

  // ---- Podešavanja, Raspored, Prijava, okvir, nova verzija, ui (SettingsPage, SchedulePage + components/schedule,
  // LoginPage, App.tsx, web/src/ui) ----
  'settings.theme.label': 'Theme',
  'settings.theme.dark': 'Dark',
  'settings.theme.light': 'Light',
  'settings.theme.system': 'System',
  'settings.appearance.title': 'Appearance',
  'settings.appearance.hint': 'System follows your phone or computer setting.',
  'settings.day.title': 'Day',
  'settings.day.start': 'Day starts at',
  'settings.day.startHint': 'Everything between midnight and this time counts toward the previous day — useful if you go to bed after midnight.',
  'settings.day.startInvalid': 'Choose a time from 00:00 to 06:00.',
  'settings.day.startSaved': 'Day start saved.',
  'settings.day.threshold': 'Streak threshold',
  'settings.day.thresholdHint': 'A day counts toward your streak when at least this much of it is done.',
  'settings.install.title': 'Install',
  'settings.install.hint': 'Opens as a separate app, without the address bar.',
  'settings.install.button': 'Install app',
  'settings.install.done': 'Ritam is installed.',
  'settings.install.iphone': 'In Safari, tap Share, then choose Add to Home Screen.',
  'settings.install.android': 'In the Chrome menu, choose Install app.',
  'settings.install.laptop': 'Laptop',
  'settings.install.laptopSteps': 'In Chrome or Edge, click the install icon in the address bar.',
  'settings.install.httpsOnly': 'Installing the app and using it offline require HTTPS.',
  'settings.backup.title': 'Backup',
  'settings.backup.download': 'Download backup',
  'settings.backup.downloadHint': 'This account’s schedule, days, tasks and notes in one JSON file.',
  'settings.backup.downloadButton': 'Download',
  'settings.backup.restore': 'Restore from backup',
  'settings.backup.restoreHint': 'Replaces all data in this account with the data from the file.',
  'settings.backup.chooseFile': 'Choose file…',
  'settings.backup.tooLarge': 'The file is too large. The limit is 20 MB.',
  'settings.backup.notJson': 'The file isn’t valid JSON.',
  'settings.backup.notBackup': 'This isn’t a Ritam backup.',
  'settings.backup.confirmTitle': 'Restore data from the backup?',
  'settings.backup.confirmBody': 'All data in this account will be replaced with the data from the backup. This can’t be undone.',
  /** {when} je settings.backup.when. */
  'settings.backup.createdAt': 'Backup created on {when}.',
  /** Vreme pravljenja kopije: {date} je fmtDateShort ("Oct 7"), {time} "21:14". */
  'settings.backup.when': '{date}, {year} at {time}',
  'settings.backup.confirm': 'Restore backup',
  'settings.reset.title': 'Reset schedule',
  /** Dodaje se na kraj settings.reset.hint i settings.reset.confirmBody* ({keeps}). */
  'settings.reset.keeps': 'Saved days, tasks and notes stay, and progress for earlier days doesn’t change.',
  'settings.reset.hint': 'Deletes all categories, templates and day-of-week assignments so you can build your schedule from scratch. {keeps}',
  'settings.reset.dayStartToo': 'Also reset the day start to 00:00 (currently {time})',
  'settings.reset.button': 'Delete schedule…',
  'settings.reset.confirmTitle': 'Reset your schedule?',
  'settings.reset.confirmBody': 'All categories ({categories}), templates ({templates}) and day-of-week assignments will be deleted. {keeps}',
  'settings.reset.confirmBodyDayStart':
    'All categories ({categories}), templates ({templates}) and day-of-week assignments will be deleted, and the day will start at 00:00 again. {keeps}',
  'settings.reset.confirmMeta': 'If you want to keep this schedule, download a backup first.',
  'settings.reset.confirm': 'Delete schedule',
  'settings.reset.done': 'Schedule deleted. Build your own on the Schedule page.',
  'settings.account.title': 'Account',
  'settings.account.signedIn': 'You’re signed in with this account.',
  'settings.account.password': 'Password',
  'settings.account.passwordHint': 'After a change, your other devices need to sign in again.',
  'settings.account.changePassword': 'Change password',
  /** Naziv reda sa dugmetom za odjavu (en "This device", sr "Odjava"); dugme je settings.account.signOut. */
  'settings.account.signOutLabel': 'This device',
  'settings.account.signOutHint': 'To sign back in on this device, you’ll need your email and password.',
  'settings.account.signOut': 'Sign out',
  'settings.account.draftTitle': 'You have an unsaved note',
  'settings.account.draftTitleMany': 'You have unsaved notes',
  'settings.account.draftOne': 'The note for {date} isn’t saved on the server. Signing out deletes it from this device.',
  /** {dates}: "Oct 6 and Oct 8" (joinAnd, fmtDateShort). */
  'settings.account.draftMany': 'The notes for {dates} aren’t saved on the server. Signing out deletes them from this device.',
  'settings.version.title': 'Version',
  /** Oznaka build-a kad je server ne javlja (razvojni server). */
  'settings.version.dev': 'development',
  'settings.version.hint': 'Ritam checks for new versions automatically and offers them in a bar at the bottom of the screen.',
  'settings.version.check': 'Check for updates',
  'settings.version.latest': 'You have the latest version.',
  'settings.version.unknown': 'The server doesn’t report its version, so it can’t be checked.',
  'settings.password.current': 'Current password',
  'settings.password.new': 'New password',
  'settings.password.currentRequired': 'Enter your current password.',
  'settings.password.changed': 'Password changed.',

  'schedule.nameLabel': 'Name',
  'schedule.nameRequired': 'Enter a name.',
  /** Kategorija koja se ne računa u ispunjenost (oznaka u listi kategorija i u Planirano nedeljno). */
  'schedule.notCounted': 'not counted',
  /** Naziv kopije šablona (Dupliraj). */
  'schedule.copyName': '{name} (copy)',
  'schedule.categories.title': 'Categories',
  'schedule.categories.new': 'New category',
  'schedule.categories.empty': 'A category gives a block its color and adds up time in Progress.',
  'schedule.category.edit': 'Edit category',
  'schedule.category.namePlaceholder': 'Category name',
  'schedule.category.color': 'Color',
  /** Boja postojeće kategorije koja nije u paleti. */
  'schedule.category.currentColor': 'Current color',
  'schedule.category.counts': 'Counts toward day completion',
  'schedule.category.countsHint':
    'Turn this off for things you don’t want to rate. It applies to earlier days too: percentages and streaks are recalculated.',
  'schedule.category.countOnTitle': 'Count toward completion?',
  'schedule.category.countOnBody':
    'This applies to earlier days too: days where this category’s blocks aren’t rated will get a lower percentage, and your streak may break.',
  'schedule.category.added': 'Category added.',
  'schedule.category.saved': 'Category saved.',
  'schedule.category.deleted': 'Category deleted.',
  'schedule.category.deleteTitle': 'Delete category “{name}”?',
  'schedule.category.deleteBody':
    'The category will no longer be available to choose. Saved days keep it, so their completion doesn’t change.',
  /** Kategorija koja se računa; {blocks} je common.blocks. */
  'schedule.category.deleteBodyBlocks':
    'The category will no longer be available to choose. Template blocks that use it ({blocks}) will have no category. Saved days keep it, so their completion doesn’t change.',
  /** Kategorija koja se ne računa: blokovi bez kategorije od sada se računaju. */
  'schedule.category.deleteBodyBlocksStartCounting':
    'The category will no longer be available to choose. Template blocks that use it ({blocks}) will have no category and will count toward completion of future days. If you don’t want that, change their category first. Saved days keep it, so their completion doesn’t change.',
  'schedule.templates.title': 'Templates',
  'schedule.templates.new': 'New template',
  'schedule.templates.empty': 'A template is a day plan that repeats.',
  /** {action} je stavka menija ⋯ na stranici Today (day.menu.resetToTemplate). */
  'schedule.templates.hint': 'Changes apply to future days you haven’t edited. To update today or earlier days, use ⋯ → {action}.',
  'schedule.templates.unassigned': 'Not assigned to any day',
  'schedule.newTemplate.copyFrom': 'Copy from',
  'schedule.newTemplate.copyHint': 'The new template gets the same blocks as the selected one.',
  'schedule.newTemplate.emptyHint': 'The template starts with no blocks.',
  'schedule.newTemplate.empty': 'Empty template',
  'schedule.newTemplate.namePlaceholder': 'Template name',
  'schedule.newTemplate.create': 'Create',
  'schedule.editor.title': 'Edit template',
  'schedule.editor.nameRequired': 'Enter a template name.',
  'schedule.editor.unassigned': 'not assigned to any day',
  'schedule.editor.blocks': 'Blocks',
  'schedule.editor.colTime': 'From – to',
  /** Zaglavlje kolone i placeholder naslova bloka. */
  'schedule.editor.colTitle': 'Title',
  'schedule.editor.colCategory': 'Category',
  'schedule.editor.noBlocks': 'This template has no blocks yet.',
  'schedule.editor.addBlock': 'Add block',
  'schedule.editor.maxBlocks': 'Up to {max} blocks.',
  'schedule.editor.overlap': 'Some blocks overlap. You can still save it like this.',
  'schedule.editor.overlapPair': '{a} and {b}',
  'schedule.editor.overlapMore': 'and {count} more',
  'schedule.editor.untitled': 'Untitled',
  'schedule.editor.duplicate': 'Duplicate',
  'schedule.editor.delete': 'Delete template',
  'schedule.editor.discardBody': 'Changes to this template aren’t saved.',
  'schedule.editor.changedElsewhere':
    'This template was changed on another device in the meantime. Save again to replace it with this version, or close without saving.',
  'schedule.editor.saved': 'Template saved.',
  'schedule.editor.duplicateTitle': 'Duplicate the saved version?',
  'schedule.editor.duplicateBody': 'The copy is made from the last saved version. Unsaved changes here are discarded.',
  'schedule.editor.duplicated': 'Copy created.',
  'schedule.editor.deleteTitle': 'Delete template “{name}”?',
  /** {days}: "Monday, Tuesday and Friday" (joinAnd, common.listAnd). */
  'schedule.editor.deleteBodyUsed': 'It’s assigned to {days}. Those days will have no template. Days already started don’t change.',
  'schedule.editor.deleteBodyUnused': 'It isn’t assigned to any day. Days already started don’t change.',
  'schedule.editor.deleted': 'Template deleted.',
  'schedule.editor.titleRequired': 'Enter a title.',
  'schedule.editor.titleTooLong': 'The title is too long.',
  'schedule.editor.timeRequired': 'Enter a start and end time.',
  'schedule.editor.timeSame': 'Start and end can’t be the same.',
  'schedule.editor.timeInvalid': 'Invalid time.',
  'schedule.editor.afterMidnight': 'After midnight, at the end of this day.',
  'schedule.editor.overMidnight': 'Past midnight, until {time} the next day.',
  /** Nazivi polja reda za čitače ekrana; {n} je redni broj bloka. */
  'schedule.editor.rowStart': 'Start, block {n}',
  'schedule.editor.rowEnd': 'End, block {n}',
  'schedule.editor.rowTitle': 'Title, block {n}',
  'schedule.editor.rowCategory': 'Category, block {n}',
  'schedule.editor.rowRemove': 'Remove block {n}',
  'schedule.editor.newCategory': '+ New category…',
  'schedule.weekdays.title': 'Days of the week',
  'schedule.weekdays.needTemplate': 'Create a template first.',
  /** Oznaka uz današnji dan u nedelji (malim slovom). */
  'schedule.weekdays.today': 'today',
  'schedule.weekdays.none': 'No template',
  'schedule.plan.title': 'Planned per week',
  'schedule.plan.counted': 'counts toward completion',
  'schedule.plan.perDay': '≈ {time} per day',
  'schedule.plan.average': 'Averaged over {n} day with a template.|Averaged over {n} days with a template.',

  'login.titleSignIn': 'Sign in · Ritam',
  'login.titleRegister': 'New account · Ritam',
  'login.subSignIn': 'Sign in to continue.',
  'login.subRegister': 'Create an account to get started.',
  'login.email': 'Email',
  'login.password': 'Password',
  'login.code': 'Sign-up code',
  'login.codeHint': 'The code is set by whoever runs the server.',
  'login.emailInvalid': 'Enter a valid email address.',
  'login.passwordRequired': 'Enter your password.',
  /** I u promeni lozinke (Podešavanja). */
  'login.passwordMin': 'Password must be at least {min} characters.',
  'login.passwordMax': 'Password can be at most {max} characters.',
  'login.passwordHint': 'At least {min} characters.',
  'login.codeRequired': 'Enter the sign-up code.',
  'login.signIn': 'Sign in',
  'login.createAccount': 'Create account',
  'login.haveAccount': 'Already have an account?',
  'login.noAccount': 'Don’t have an account?',

  /** Nazivi stranica: navigacija, naslov taba ("Progress · Ritam") i naslovi Raspored / Podešavanja / 404. */
  'shell.page.today': 'Today',
  'shell.page.progress': 'Progress',
  'shell.page.journal': 'Journal',
  'shell.page.schedule': 'Schedule',
  'shell.page.settings': 'Settings',
  'shell.page.notFound': 'Not found',
  'shell.skipToContent': 'Skip to content',
  'shell.mainNav': 'Main navigation',
  'shell.homeLink': 'Ritam — Today',
  'shell.serverStale': 'Can’t reach the server — showing saved data.',
  'shell.offline': 'No internet — changes aren’t saved.',
  'shell.loadFailed': 'Your data didn’t load.',
  'shell.notFound.title': 'This page doesn’t exist.',
  'shell.notFound.text': 'Check the address or go back to today.',
  'shell.notFound.goToday': 'Go to Today',
  'shell.crash.title': 'This page couldn’t be displayed.',
  'shell.crash.text': 'Your data on the server wasn’t affected. Reload the page.',

  'update.available': 'A new version is available.',
  'update.refresh': 'Refresh',
  'update.refreshing': 'Refreshing…',
  'update.hide': 'Hide',
  'update.hideLabel': 'Hide new version notice',

  'ui.loading': 'Loading',
  /** Podrazumevano dugme potvrde (confirmDialog bez confirmText). */
  'ui.confirm': 'Confirm',
  'ui.discard.title': 'Discard changes?',
  'ui.discard.body': 'Your changes aren’t saved.',
  'ui.discard.confirm': 'Discard',
  'ui.discard.keepEditing': 'Keep editing',
  /** Izbor vremena (TimeInput): {label} je naziv polja ("Start, block 2"). */
  'ui.time.hour': '{label}: hour',
  'ui.time.minutes': '{label}: minutes',
  'ui.categoryPicker.label': 'Category',
  'ui.categoryPicker.new': 'New category',
  /** Vidljiv tekst čipa "+ New". */
  'ui.categoryPicker.newShort': 'New',
  'ui.categoryPicker.namePlaceholder': 'Category name',
  'ui.categoryPicker.nameLabel': 'New category name',
  'ui.categoryPicker.nameRequired': 'Enter a category name.',
  'ui.categoryPicker.create': 'Add category',
  'ui.categoryPicker.cancel': 'Cancel',
  'ui.categoryPicker.cancelLabel': 'Cancel new category',
  'ui.categoryPicker.failed': 'The category wasn’t created. Try again.',
  'ui.rating.label': 'Day rating',
  'ui.rating.1': 'Bad',
  'ui.rating.2': 'Poor',
  'ui.rating.3': 'Okay',
  'ui.rating.4': 'Good',
  'ui.rating.5': 'Great',
  'ui.rating.value': 'Rating {value} of 5',
} as const satisfies Record<string, string>;

export type MessageKey = keyof typeof en;
