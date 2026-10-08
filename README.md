# Ritam

Ritam je aplikacija koja dan deli na vremenske blokove. Svaki blok čekiraš kao urađen, delimično urađen ili neurađen. Uz to vodiš zadatke i beleške za svaki dan, a aplikacija prati koliko ispunjavaš plan.
Radi u browseru na laptopu i kao instalirana aplikacija (PWA) na telefonu. Svi podaci su na tvom serveru,
u jednoj SQLite bazi. Prijava je nalogom (email i lozinka); svaki nalog ima svoje, potpuno odvojene podatke.

## Pokretanje lokalno (Docker)

Treba ti Docker Desktop. U folderu projekta:

```bash
docker compose up -d --build
```

Otvori http://localhost:3001 i izaberi **Napravi nalog**: email, lozinka (bar 8 znakova) i **kod za registraciju**,
a to je `APP_PASSWORD` iz fajla `.env`. Ako fajl ne postoji, napravi ga po uzoru na `.env.example` (`APP_PASSWORD` i
`SESSION_SECRET` su obavezni). Vrednosti u `.env` piši u jednostrukim navodnicima (`APP_PASSWORD='…'`): bez njih
Docker Compose menja znak `$`, pa pravi kod ne bi radio.

`docker-compose.yml` vezuje aplikaciju samo na `127.0.0.1:3001`, pa je na serveru dostupna samo preko
Nginx-a na istoj mašini. Gotov config je u `deploy/nginx/ritamorg.com.conf`, a koraci su u Opciji B ispod.

Zaustavljanje: `docker compose down`. Podaci ostaju u Docker volumenu `<ime foldera>_ritam-data`
(npr. `app_ritam-data`; vidi `docker volume ls`).

## Nalozi

- **Prijava**: email i lozinka. Nema dvostepene provere ni resetovanja lozinke — zapamti lozinku (menadžer lozinki) i
  povremeno preuzmi rezervnu kopiju. Lozinku menjaš u **Podešavanjima → Nalog → Promeni lozinku**; to odjavljuje sve
  ostale uređaje.
- **Registracija** (env `SIGNUP`):
  - `code` — nalog može da napravi samo ko zna kod za registraciju: `SIGNUP_CODE`, a ako nije postavljen
    `APP_PASSWORD`. Ovo je podrazumevano kad kod postoji (i u `docker-compose.yml`, koji uvek prosleđuje `APP_PASSWORD`).
  - `open` — svako ko vidi server može da napravi nalog. Podrazumevano kad koda nema (npr. `npm run dev`), i tada
    server sluša samo na ovoj mašini (127.0.0.1): na adresi dostupnoj iz mreže (npr. `HOST=0.0.0.0` u Docker-u) se
    bez koda ne pokreće, osim uz izričit `SIGNUP=open` (tada upozorava u logu).
  - `closed` — nove naloge niko ne može da napravi (postojeći se normalno prijavljuju). Kad napraviš svoje naloge,
    dodaj `SIGNUP: closed` u `environment` u `docker-compose.yml` (ili u Railway Variables) i ponovo pokreni kontejner.
- **`APP_PASSWORD` više nije lozinka za prijavu**, nego kod za registraciju. Promena koda nikog ne odjavljuje.
- **Prvi nalog preuzima postojeće podatke.** Ako si Ritam koristio pre naloga, posle ažuriranja svi dosadašnji
  podaci (dani, blokovi, zadaci, beleške, raspored i podešavanja) čekaju vlasnika; u logu piše
  `Ritam: baza ima podatke iz verzije bez naloga — prvi nalog koji se registruje ih preuzima.` Zato odmah posle
  ažuriranja napravi **svoj** nalog (sa kodom = dosadašnji `APP_PASSWORD`): on dobija sve, ništa se ne briše ni ne
  menja. Svaki sledeći nalog počinje prazan.
- **Sesija**: aplikacija dobija kratak access token (15 min, samo u memoriji) i refresh token (HttpOnly kolačić,
  90 dana), koji se menja pri svakom osvežavanju. Uređaj koji se koristi ostaje prijavljen; uređaj koji se ne otvori
  90 dana se odjavi. Stari refresh token upotrebljen ponovo (krađa kolačića) odjavljuje taj uređaj.
- **Ograničenja**: 10 neuspelih prijava u 15 minuta po adresi i po email-u (uspele prijave se ne računaju, pa ni više
  uređaja iza iste adrese ne dolazi do blokade), 10 pogrešnih trenutnih lozinki pri promeni lozinke po nalogu i
  10 pokušaja registracije u 15 minuta po adresi.
- **Id-jevi** (blokovi, zadaci, kategorije, šabloni) se dodeljuju redom za ceo server, zajedno za sve naloge: po
  razmaku između svojih id-jeva nalog može da proceni koliko i kada su drugi nalozi nešto pravili (ne i šta). Za
  server koji deli porodica to je prihvatljivo.

## Razvoj bez Dockera

```bash
npm install
npm run dev
```

Server radi na :3000, a Vite sa hot reload-om na http://localhost:5173. Bez `APP_PASSWORD`/`SIGNUP_CODE`
registracija je otvorena (napravi nalog na ekranu prijave), pa server sluša samo na ovoj mašini (127.0.0.1). Za
pristup sa telefona u istoj mreži postavi `SIGNUP_CODE` (kod za registraciju): tada sluša na svim adresama, a nalog
može da napravi samo ko zna kod. Ako postojeća baza (`./data`) ima podatke iz verzije bez naloga, prvi nalog ih preuzima.

Ostale komande: `npm run typecheck`, `npm run build`, `npm start` (produkcijski server, servira `dist/web`).

Test svih API ruta (`scripts/smoke.mjs`) se pokreće samo na posebnoj, privremenoj instanci (nikad na pravoj): pravi
svoje naloge, a prvi nalog na serveru bi preuzeo podatke iz verzije bez naloga. Proverava registraciju, prijavu,
istek i obnovu tokena, rotaciju refresh tokena, odjavu, promenu lozinke, ograničenja pokušaja, sve funkcije
aplikacije (kao nalog A) i potpunu odvojenost podataka dva naloga. Kratak `ACCESS_TOKEN_TTL_SEC` i
`REFRESH_RACE_GRACE_SEC` (isti broj za server i test) skraćuju čekanje u proverama isteka i ponovo upotrebljenog tokena.
Zatvorenu registraciju proverava uz drugu privremenu instancu sa `SIGNUP=closed` (`SMOKE_CLOSED_URL`). Obe instance
uvek pokreni sa novim, praznim `DATA_DIR`:

```bash
DATA_DIR=/tmp/ritam-test PORT=3999 SIGNUP_CODE=x ACCESS_TOKEN_TTL_SEC=3 REFRESH_RACE_GRACE_SEC=2 npm start
DATA_DIR=/tmp/ritam-closed PORT=3998 SIGNUP=closed npm start
BASE_URL=http://localhost:3999 SMOKE_CLOSED_URL=http://localhost:3998 SIGNUP_CODE=x REFRESH_RACE_GRACE_SEC=2 node scripts/smoke.mjs
```

Na kraju piše `Ukupno: N PASS, 0 FAIL`. Bez druge instance (bez `SMOKE_CLOSED_URL`) provera zatvorene registracije se
preskače, pa zbir ima `1 SKIP` i manje PASS-ova — to nije greška.

## Prvi koraci

Novi nalog počinje prazan: nema unapred napravljenih kategorija, šablona ni rasporeda. Sve unosiš sam, onako kako
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
tri šablona, šablon za svaki dan u nedelji i početak dana u 01:00). Taj primer ostaje i posle ažuriranja (prvi nalog
ga preuzima sa ostalim podacima), jer aplikacija nikad sama ne briše tvoje podatke. Ukloniš ga u **Podešavanjima** →
**Raspored ispočetka**: brišu se sve kategorije, šabloni i dodela šablona danima u nedelji, a po želji se i "Dan
počinje u" vraća na 00:00. Sačuvani dani, ocene blokova, zadaci i beleške ostaju, pa se ni napredak ranijih dana ne
menja. Zatim napravi svoj raspored po koracima iznad. Ako želiš da sačuvaš i stari raspored, pre toga preuzmi kopiju (JSON).

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

Aplikacija je jedan Docker kontejner sa jednim volumenom (`/data`). Obavezna env promenljiva je kod za registraciju
(`APP_PASSWORD` ili `SIGNUP_CODE`), osim uz `SIGNUP=open`/`closed`; bez nje se server u kontejneru ne pokreće. PWA na
telefonu traži HTTPS.

### Opcija A: Railway (najlakše, bez održavanja servera)

1. Postavi projekat na GitHub kao privatni repo.
2. Na railway.com napravi projekat sa opcijom "Deploy from GitHub repo". Railway sam prepozna `Dockerfile`.
3. U servisu dodaj **Volume** sa mount putanjom `/data`.
4. U **Variables** postavi `APP_PASSWORD` (kod za registraciju; dugačak, nasumičan) i `SESSION_SECRET`
   (`openssl rand -hex 32`, bar 32 znaka). Dodaj i `RAILWAY_RUN_UID=0`: Railway volumen pripada root-u, a aplikacija u kontejneru
   inače radi kao korisnik `node` i ne bi mogla da upiše bazu. Dodaj i `TRUST_PROXY=1`: zahtevi stižu preko Railway
   proxy-ja, pa se adresa klijenta (za ograničenje pokušaja prijave) čita iz `X-Forwarded-For`.
5. U **Networking** klikni "Generate Domain". Dobijaš `https://<ime>.up.railway.app`. Otvori ga i napravi svoj nalog.
6. Proveri adresu klijenta: na stranici prijave namerno unesi pogrešnu lozinku, pa u logu servisa
   (Deployments → View Logs) nađi red `Ritam: neuspela prijava (adresa …)`. Tu treba da piše tvoja javna IP adresa
   (vidi je npr. na https://ifconfig.me). Ako piše neka druga (adresa Railway-a), postavi `TRUST_PROXY=2` i proveri
   ponovo. Inače bi svi klijenti delili isto ograničenje od 10 pogrešnih pokušaja na 15 minuta.

### Opcija B: VPS + Nginx (npr. Hetzner)

Docker pokreće samo aplikaciju na `127.0.0.1:3001`, a Nginx na serveru prima HTTPS i prosleđuje joj zahteve.
Primer je za domen `ritamorg.com`; ako koristiš drugi, zameni ga u komandama i u
`deploy/nginx/ritamorg.com.conf`.

1. **DNS:** A zapisi `ritamorg.com` i `www.ritamorg.com` pokazuju na javnu IP adresu servera.
2. **Docker i aplikacija:**

   ```bash
   curl -fsSL https://get.docker.com | sh
   git clone https://github.com/IlijaIvanovic78/Ritam.git && cd Ritam
   cp .env.example .env && nano .env      # APP_PASSWORD (kod za registraciju) i SESSION_SECRET, u jednostrukim navodnicima
   docker compose up -d --build
   curl http://127.0.0.1:3001/api/health  # {"ok":true,...}
   ```

   `SESSION_SECRET` generiši sa `openssl rand -hex 32` (bar 32 znaka; kraći server prihvata uz upozorenje u logu, jer
   ga svako ko ima nalog može offline pogađati iz svog tokena i onda lažirati tokene za druge naloge).
3. **Nginx:**

   ```bash
   sudo apt install -y nginx
   sudo cp deploy/nginx/ritamorg.com.conf /etc/nginx/sites-available/ritamorg.com
   sudo ln -s /etc/nginx/sites-available/ritamorg.com /etc/nginx/sites-enabled/
   sudo nginx -t && sudo systemctl reload nginx
   ```

4. **HTTPS (Let's Encrypt):**

   ```bash
   sudo apt install -y certbot python3-certbot-nginx
   sudo certbot --nginx -d ritamorg.com -d www.ritamorg.com
   ```

   Certbot dopiše HTTPS deo u Nginx config, preusmeri HTTP na HTTPS i sam obnavlja sertifikat.
5. **Firewall:** otvori samo 22, 80 i 443 (`sudo ufw allow OpenSSH && sudo ufw allow 'Nginx Full' && sudo ufw enable`,
   ili isto u Hetzner Cloud Firewall-u). Port 3001 ne otvaraj, jer je vezan samo za 127.0.0.1.
6. Otvori `https://ritamorg.com` i napravi svoj nalog (kod = `APP_PASSWORD`).

**Nadogradnja:** pre nadogradnje u aplikaciji preuzmi kopiju (**Podešavanja → Preuzmi kopiju (JSON)**) ili sačuvaj
ceo volumen (vidi "Rezervna kopija"), pa `git pull && docker compose up -d --build`. Posle nadogradnje sa verzije bez
naloga odmah napravi svoj nalog — prvi nalog preuzima sve postojeće podatke (vidi "Nalozi"). Aplikacija koja je ostala
otvorena (npr. PWA na telefonu) može još jednom da pokaže staru prijavu samo sa lozinkom i poruku "Ritam je ažuriran.
Osveži stranicu…": osveži je (ili zatvori i ponovo otvori aplikaciju) i prijavi se email-om.

Aplikacija koja je otvorena tokom nadogradnje (PWA na telefonu, tab na laptopu) se ne učitava sama: pri povratku u nju
(ili najkasnije za 30 min) na dnu se pojavi traka "Dostupna je nova verzija." — dodir na **Osveži** prvo sačuva belešku
u kucanju, pa učita novu verziju. Proverava se i ručno: **Podešavanja → Verzija → Proveri ažuriranje**.

Kad nova verzija menja šemu baze, server pri prvom pokretanju u `/data` (`DATA_DIR`) napravi i kopiju baze pre
promene, `ritam.db.pre-v<N>-<datum-vreme>.bak` (u logu: `Ritam: kopija baze pre nadogradnje šeme …`). Prethodna verzija
aplikacije ne otvara bazu novije šeme, pa je to (uz JSON kopiju) put nazad: dok aplikacija ne radi, vrati tu datoteku
kao `ritam.db` (i obriši `ritam.db-wal` i `ritam.db-shm`), pa pokreni prethodnu verziju. Kopija sadrži sve podatke kao
i baza; obriši je kad nova verzija proradi.

### Instalacija na telefon

- **iPhone**: otvori adresu u Safariju, pa Podeli → Dodaj na početni ekran.
- **Android**: otvori adresu u Chrome-u, pa meni (⋮) → Instaliraj aplikaciju.
- **Laptop**: u Chrome-u ili Edge-u klikni ikonicu za instalaciju u adresnoj traci, ili samo koristi stranicu kao sajt.

### Izgubljen telefon

Na drugom uređaju se prijavi i promeni lozinku (**Podešavanja → Nalog → Promeni lozinku**): svi ostali uređaji se
odjavljuju odmah (access token koji je telefon već imao važi još najviše 15 minuta). Promena `APP_PASSWORD` menja samo
kod za registraciju, a promena `SESSION_SECRET` samo traži nove access tokene — nijedna ne odjavljuje uređaje.

### Rezervna kopija

Glavni način: u Podešavanjima "Preuzmi kopiju (JSON)". Kopija sadrži podatke prijavljenog naloga i vraća se sa
"Vrati iz kopije…", koje zamenjuje samo podatke tog naloga (i kopiju iz verzije bez naloga ili sa drugog naloga).

Na VPS-u možeš da sačuvaš i ceo volumen (svi nalozi), ali samo dok aplikacija ne radi: dok radi, najnovije izmene
stoje u `ritam.db-wal`, pa bi sama kopija `ritam.db` bila nepotpuna ili prazna. Uredno zaustavljanje ih upiše u `ritam.db`:

```bash
docker compose stop ritam
docker compose cp ritam:/data ./ritam-kopija
docker compose start ritam
```

Za vraćanje podataka koristi JSON kopiju.
