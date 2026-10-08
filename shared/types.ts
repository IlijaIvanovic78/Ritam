// Tipovi koje dele server i web klijent. Sve vremenske vrednosti su u minutima
// od 00:00 datuma kome blok pripada; vrednosti >= 1440 znače "posle ponoći".

export type BlockStatus = 'pending' | 'done' | 'partial' | 'skipped';

export type Weekday = 1 | 2 | 3 | 4 | 5 | 6 | 7; // ISO: 1 = ponedeljak … 7 = nedelja

export interface Category {
  id: number;
  name: string;
  color: string; // '#rrggbb'
  counts: boolean; // da li ulazi u procenat ispunjenosti dana
  sort: number;
}

export interface Block {
  /** Pozitivan = sačuvan blok. Negativan = pregled iz šablona (dan još nije inicijalizovan). */
  id: number;
  date: string; // 'YYYY-MM-DD'
  start: number;
  end: number;
  title: string;
  categoryId: number | null;
  status: BlockStatus;
  /** Stvarno odrađeni minuti; null = podrazumevano (done = ceo blok, partial = pola). */
  actualMin: number | null;
  note: string;
}

export interface Task {
  id: number;
  date: string;
  title: string;
  done: boolean;
  doneAt: string | null; // ISO timestamp
  categoryId: number | null;
  sort: number;
  createdAt: string; // ISO timestamp
}

export interface DayPayload {
  date: string;
  /** true = blokovi su sačuvani za ovaj dan; false = `blocks` je pregled iz šablona (negativni id-jevi). */
  initialized: boolean;
  templateId: number | null;
  templateName: string | null;
  note: string;
  rating: number | null; // 1..5
  blocks: Block[]; // sortirano po start, end, id
  tasks: Task[]; // nezavršeni (po sort, id), pa završeni (po doneAt)
  /** Broj nezavršenih zadataka sa datumom pre ovog dana (za "prebaci u danas"). */
  openBefore: number;
}

export interface TemplateBlock {
  id: number;
  templateId: number;
  start: number;
  end: number;
  title: string;
  categoryId: number | null;
}

export interface Template {
  id: number;
  name: string;
  sort: number;
  blocks: TemplateBlock[]; // sortirano po start
}

export type WeekdayMap = Record<Weekday, number | null>; // dan u nedelji → id šablona

export interface Settings {
  /** Kada logički počinje dan, u minutima od ponoći (0..360). Podrazumevano 0 = 00:00. */
  dayStart: number;
  /** Prag ispunjenosti (0..1) da bi se dan računao u niz. Podrazumevano 0.7. */
  streakThreshold: number;
}

export interface SchedulePayload {
  categories: Category[]; // sortirano po sort, id; samo kategorije koje se nude za izbor
  /**
   * Obrisane kategorije: sačuvani blokovi i zadaci ih zadržavaju (naziv, boja i "računa se" ostaju
   * isti za ranije dane). Samo za prikaz i računanje ispunjenosti — ne nude se za izbor i ne mogu
   * se menjati. Nema ga u kopiji iz keša od starije verzije servera.
   */
  archivedCategories?: Category[];
  templates: Template[]; // sortirano po sort, id
  weekdays: WeekdayMap;
  settings: Settings;
}

// ---- Ulazni tipovi za mutacije ----

export interface BlockInput {
  start: number;
  end: number;
  title: string;
  categoryId: number | null;
}

export interface BlockPatch {
  start?: number;
  end?: number;
  title?: string;
  categoryId?: number | null;
  status?: BlockStatus;
  actualMin?: number | null;
  note?: string;
}

/** `PATCH /api/days/:date`: beleška i/ili ocena dana. */
export interface DayPatch {
  note?: string;
  /**
   * Beleška na serveru na koju se izmena oslanja (uz `note`). Ako je beleška u međuvremenu promenjena
   * na drugom uređaju (nije ni `baseNote` ni novi tekst) → 409 i ništa se ne upisuje.
   */
  baseNote?: string;
  rating?: number | null;
}

export interface TaskPatch {
  title?: string;
  done?: boolean;
  categoryId?: number | null;
  date?: string;
  sort?: number;
}

export interface CategoryInput {
  name: string;
  color: string;
  counts: boolean;
}

export type TemplateBlockInput = BlockInput;

/**
 * `POST /api/schedule/reset` ("Raspored ispočetka"): briše sve kategorije, šablone i dodelu šablona
 * danima u nedelji. Sačuvani dani, blokovi, zadaci, beleške i ocene ostaju (i njihova ispunjenost).
 */
export interface ScheduleResetInput {
  /** true = i "Dan počinje u" se vraća na 00:00. */
  dayStart?: boolean;
}

// ---- Statistika ----

export interface CategoryTime {
  categoryId: number | null;
  plannedMin: number;
  doneMin: number;
  plannedCount: number; // broj blokova
  doneCount: number; // done = 1, partial = 0.5
}

export interface BlockSummary {
  /** (done + 0.5 * partial) / counted; null ako nema blokova koji se računaju. */
  score: number | null;
  counted: number;
  done: number;
  partial: number;
  skipped: number;
  pending: number;
  plannedMin: number; // samo kategorije koje se računaju
  doneMin: number; // samo kategorije koje se računaju
  categories: CategoryTime[]; // sve kategorije u danu, sortirano po plannedMin opadajuće
}

export interface StatsDay {
  date: string;
  initialized: boolean;
  /** null ako dan nije praćen: nije inicijalizovan ili nijedan blok još nema status. */
  summary: BlockSummary | null;
  tasksTotal: number;
  tasksDone: number;
  rating: number | null;
  hasNote: boolean;
}

export interface StatsPayload {
  from: string;
  to: string;
  days: StatsDay[]; // svaki datum u opsegu, rastuće
  totals: {
    categories: CategoryTime[]; // zbir za praćene dane (summary != null)
    tasksTotal: number;
    tasksDone: number;
    avgScore: number | null; // prosek score-a praćenih dana koji imaju score
    avgRating: number | null;
    daysTracked: number; // broj praćenih dana (summary != null)
  };
  /**
   * Uzastopni dani do `to` sa score >= praga. Dan `to` ne prekida niz ako još traje
   * (nije poslat `today`, ili `to >= today`) i nije dostigao prag.
   */
  streak: number;
}

export interface JournalEntry {
  date: string;
  note: string;
  rating: number | null;
  score: number | null;
  tasksDone: number;
  tasksTotal: number;
}

export interface AuthState {
  authRequired: boolean;
  authenticated: boolean;
}

/** GET /api/health */
export interface HealthPayload {
  ok: true;
  /**
   * Glavni JS fajl web build-a koji server servira ("/assets/index-….js"), pročitan iz index.html
   * pri pokretanju. Klijent ga poredi sa svojim da bi se posle deploy-a učitao ponovo.
   * Nema ga kad server ne servira build (razvoj preko Vite-a).
   */
  build?: string;
}
