# Ritam

Ritam je lična aplikacija koja dan deli na vremenske blokove. Svaki blok čekiraš kao urađen, delimično urađen ili neurađen. Uz to vodiš zadatke i beleške za svaki dan, a aplikacija prati koliko ispunjavaš plan.
Radi u browseru na laptopu i kao instalirana aplikacija (PWA) na telefonu. Svi podaci su na tvom serveru,
u jednoj SQLite bazi.

## Pokretanje lokalno (Docker)

Treba ti Docker Desktop. U folderu projekta:

```bash
docker compose up -d --build
```

Otvori http://localhost:3000. Lozinka je `APP_PASSWORD` iz fajla `.env`; ako fajl ne postoji, napravi ga
po uzoru na `.env.example`. Vrednosti u `.env` piši u jednostrukim navodnicima (`APP_PASSWORD='…'`):
bez njih Docker Compose menja znak `$` u lozinki, pa prava lozinka ne bi radila.

Zaustavljanje: `docker compose down`. Podaci ostaju u Docker volumenu `<ime foldera>_ritam-data`
(npr. `app_ritam-data`; vidi `docker volume ls`).

## Razvoj bez Dockera

```bash
npm install
npm run dev
```

Server radi na :3000, a Vite sa hot reload-om na http://localhost:5173. Ako `APP_PASSWORD` nije postavljen,
prijava je isključena (samo za lokalni rad) i server sluša samo na 127.0.0.1; za pristup sa telefona u istoj mreži
postavi `APP_PASSWORD` u okruženju (tada server sluša na svim adresama). Bez lozinke server neće da se pokrene na
adresi dostupnoj iz mreže (npr. u Docker-u, `HOST=0.0.0.0`), osim uz `ALLOW_NO_AUTH=1`.

Ostale komande: `npm run typecheck`, `npm run build`, `npm start` (produkcijski server, servira `dist/web`).

Test svih API ruta menja podatke, pa se pokreće samo na posebnoj, privremenoj instanci (nikad na pravoj).
Proverava da je nova baza prazna, pa sam pravi svoje kategorije, šablone i raspored (i proverava "Raspored
ispočetka" na bazi iz ranije verzije):

```bash
DATA_DIR=/tmp/ritam-test PORT=3999 APP_PASSWORD=x npm start
BASE_URL=http://localhost:3999 PASSWORD=x node scripts/smoke.mjs
```

## Prvi koraci

Aplikacija počinje prazna: nema unapred napravljenih kategorija, šablona ni rasporeda. Sve unosiš sam, onako kako
ti odgovara. Posle prve prijave otvori **Raspored**:

1. **Kategorije**: napravi kategorije za ono što radiš tokom dana (bilo koji naziv i boja). Za svaku biraš da li se
   računa u ispunjenost dana.
2. **Šabloni**: napravi šablon dana i dodaj mu blokove (od–do, naslov, kategorija). Šablona može biti koliko hoćeš,
   a novi možeš da napraviš i kao kopiju postojećeg.
3. **Dani u nedelji**: za svaki dan izaberi šablon ili ga ostavi bez šablona.
4. Po želji u **Podešavanjima** promeni "Dan počinje u" (podrazumevano 00:00, vidi ispod).

Dan bez šablona je prazan dan, a blokove mu možeš dodati i ručno. Ako si danas otvorio pre nego što si napravio
šablon, dan se sam popuni čim šablon dodeliš tom danu u nedelji — osim ako si mu već ručno dodao blok; tada ti traka
na stranici Danas ponudi „Primeni“ (ili ⋯ → Primeni drugi šablon…).

**Ako aplikaciju koristiš od ranije verzije**: ranija verzija je novu bazu punila primerom rasporeda (kategorije,
tri šablona, šablon za svaki dan u nedelji i početak dana u 01:00). Taj primer ostaje i posle ažuriranja, jer
aplikacija nikad sama ne briše tvoje podatke. Ukloniš ga u **Podešavanjima** → **Raspored ispočetka**: brišu se sve
kategorije, šabloni i dodela šablona danima u nedelji, a po želji se i "Dan počinje u" vraća na 00:00. Sačuvani
dani, ocene blokova, zadaci i beleške ostaju, pa se ni napredak ranijih dana ne menja. Zatim napravi svoj raspored
po koracima iznad. Ako želiš da sačuvaš i stari raspored, pre toga preuzmi kopiju (JSON).

## Kako radi

- **Raspored**: tvoji šabloni dana i koji šablon važi za koji dan u nedelji. Kategorije imaju boju i podešavanje da
  li se računaju u procenat ispunjenosti. Nijedan naziv nema posebno značenje: sve se ponaša isto, kako god ga nazoveš.
- **Danas**: kad otvoriš dan, blokovi se kopiraju iz šablona. Posle toga dan možeš da menjaš: dvema aktivnostima
  zameniš termine, promeniš kategoriju, blok podeliš na dva dela ili dodaš novi. Izmene šablona važe samo za dane
  koje još nisi otvorio.
- **Dan počinje u 00:00** (podešava se do 06:00): ako ti dan traje i posle ponoći, postavi npr. 01:00. Tada ono što
  radiš posle ponoći a pre 01:00 pripada prethodnom danu, a blok koji počinje u 01:00 je na početku novog dana.
- **Ispunjenost dana**: urađen blok vredi 1, delimičan 0,5. Zbir se deli brojem blokova koji se računaju.
  Na stranici Napredak vidiš nedelju, mesec, niz uzastopnih dana i vreme po kategorijama.

## Postavljanje na internet

Aplikacija je jedan Docker kontejner sa jednim volumenom (`/data`) i jednom obaveznom env promenljivom
(`APP_PASSWORD`). PWA na telefonu traži HTTPS.

### Opcija A: Railway (najlakše, bez održavanja servera)

1. Postavi projekat na GitHub kao privatni repo.
2. Na railway.com napravi projekat sa opcijom "Deploy from GitHub repo". Railway sam prepozna `Dockerfile`.
3. U servisu dodaj **Volume** sa mount putanjom `/data`.
4. U **Variables** postavi `APP_PASSWORD` (jaka lozinka; bez nje se aplikacija ne pokreće) i `SESSION_SECRET`
   (`openssl rand -hex 32`). Dodaj i `RAILWAY_RUN_UID=0`: Railway volumen pripada root-u, a aplikacija u kontejneru
   inače radi kao korisnik `node` i ne bi mogla da upiše bazu. Dodaj i `TRUST_PROXY=1`: zahtevi stižu preko Railway
   proxy-ja, pa se adresa klijenta (za ograničenje pokušaja prijave) čita iz `X-Forwarded-For`.
5. U **Networking** klikni "Generate Domain". Dobijaš `https://<ime>.up.railway.app`.
6. Proveri adresu klijenta: na stranici prijave namerno unesi pogrešnu lozinku, pa u logu servisa
   (Deployments → View Logs) nađi red `Ritam: pogrešna lozinka (adresa …)`. Tu treba da piše tvoja javna IP adresa
   (vidi je npr. na https://ifconfig.me). Ako piše neka druga (adresa Railway-a), postavi `TRUST_PROXY=2` i proveri
   ponovo. Inače bi svi klijenti delili isto ograničenje od 10 pogrešnih pokušaja na 15 minuta.

### Opcija B: VPS + sopstveni domen

1. Iznajmi mali Linux VPS (dovoljni su 1 vCPU i 1 GB RAM) i kupi domen.
2. Na DNS-u domena dodaj A zapis koji pokazuje na IP adresu servera.
3. Na serveru instaliraj Docker, kopiraj projekat, napravi `.env` po uzoru na `.env.example` (`APP_PASSWORD`,
   `DOMAIN`, po želji `SESSION_SECRET`; vrednosti u jednostrukim navodnicima), pa pokreni:

   ```bash
   docker compose -f docker-compose.prod.yml up -d --build
   ```

   Caddy sam izdaje i obnavlja HTTPS sertifikat za `DOMAIN`.

### Instalacija na telefon

- **iPhone**: otvori adresu u Safariju, pa Podeli → Dodaj na početni ekran.
- **Android**: otvori adresu u Chrome-u, pa meni (⋮) → Instaliraj aplikaciju.
- **Laptop**: u Chrome-u ili Edge-u klikni ikonicu za instalaciju u adresnoj traci, ili samo koristi stranicu kao sajt.

### Izgubljen telefon

Promena `APP_PASSWORD` (ili `SESSION_SECRET`) odjavljuje sve uređaje. `.env` se čita samo kad se kontejner pravi,
pa posle izmene pokreni `docker compose up -d` (na VPS-u `docker compose -f docker-compose.prod.yml up -d`);
`restart` ne učitava novi `.env`. Na Railway-u posle izmene promenljive klikni **Deploy**. Zatim se ponovo prijavi
na uređajima koje koristiš.

Prijava ostaje važeća dok se uređaj koristi (sesija se sama obnavlja); uređaj koji se ne otvori 400 dana se odjavi.

### Rezervna kopija

Glavni način: u Podešavanjima "Preuzmi kopiju (JSON)". Ta kopija je potpuna i vraća se sa "Vrati iz kopije…".

Na VPS-u možeš da sačuvaš i ceo volumen, ali samo dok aplikacija ne radi: dok radi, najnovije izmene stoje u
`ritam.db-wal`, pa bi sama kopija `ritam.db` bila nepotpuna ili prazna. Uredno zaustavljanje ih upiše u `ritam.db`:

```bash
docker compose -f docker-compose.prod.yml stop ritam
docker compose -f docker-compose.prod.yml cp ritam:/data ./ritam-kopija
docker compose -f docker-compose.prod.yml start ritam
```

Za vraćanje podataka koristi JSON kopiju.
