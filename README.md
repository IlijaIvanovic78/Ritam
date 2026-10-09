# Ritam

Ritam je aplikacija koja dan deli na vremenske blokove. Svaki blok čekiraš kao urađen, delimično urađen ili neurađen. Uz to vodiš zadatke i beleške za svaki dan, a aplikacija prati koliko ispunjavaš plan.
Radi u browseru na laptopu i kao instalirana aplikacija (PWA) na telefonu. Svi podaci su na tvom serveru,
u jednoj SQLite bazi. Prijava je nalogom (email i lozinka); svaki nalog ima svoje, potpuno odvojene podatke.

## Pokretanje lokalno (Docker)

Treba ti Docker Desktop. U folderu projekta:

```bash
docker compose up -d --build
```

Pre prvog pokretanja napravi fajl `.env` po uzoru na `.env.example`. Obavezan je samo `SESSION_SECRET`
(`openssl rand -hex 32`); vrednosti piši u jednostrukim navodnicima (`SESSION_SECRET='…'`), jer bez njih Docker
Compose menja znak `$`.

Otvori http://localhost:3001 i izaberi **Napravi nalog**: samo email i lozinka (bar 8 znakova). Posle toga se
prijavljuješ istim email-om i lozinkom. Posebne lozinke ili koda aplikacije nema (nekadašnji `APP_PASSWORD` se više ne
koristi, pa ga možeš obrisati iz `.env`).

`docker-compose.yml` vezuje aplikaciju samo na `127.0.0.1:3001`, pa je na serveru dostupna samo preko
Nginx-a na istoj mašini. Gotov config je u `deploy/nginx/ritamorg.com.conf`, a koraci su u Opciji B ispod.

Zaustavljanje: `docker compose down`. Podaci ostaju u Docker volumenu `<ime foldera>_ritam-data`
(npr. `app_ritam-data`; vidi `docker volume ls`).

## Nalozi

- **Prijava**: email i lozinka. Nema dvostepene provere ni resetovanja lozinke — zapamti lozinku (menadžer lozinki) i
  povremeno preuzmi rezervnu kopiju. Lozinku menjaš u **Podešavanjima → Nalog → Promeni lozinku**; to odjavljuje sve
  ostale uređaje.
- **Registracija** (env `SIGNUP`, u Docker-u iz `.env`):
  - `open` (podrazumevano) — nalog pravi svako ko otvori aplikaciju, samo email-om i lozinkom. Svaki nalog vidi
    samo svoje podatke. Na javnom serveru to znači da svako ko nađe sajt može da napravi nalog i čuva podatke na
    tvom serveru, bez ograničenja veličine po nalogu.
  - `closed` — nove naloge niko ne može da napravi, a postojeći se normalno prijavljuju. Kad napraviš svoje naloge
    (i naloge ukućana), ovo drži aplikaciju privatnom: dodaj `SIGNUP='closed'` u `.env` i pokreni
    `docker compose up -d` (na Railway-u: `SIGNUP=closed` u Variables). Za nov nalog kasnije privremeno ukloni tu
    liniju.
  - `code` — nalog može da napravi samo ko zna kod: `SIGNUP='code'` i `SIGNUP_CODE='…'` u `.env`. Kod se unosi
    samo pri registraciji; prijava je i dalje email i lozinka. Bez `SIGNUP_CODE` server se ne pokreće.
- **Nema lozinke aplikacije.** `APP_PASSWORD` se više ne koristi ni za prijavu ni za registraciju; ako je još
  postavljen, server ga ignoriše (jedan red u logu to kaže).
- **Prvi nalog preuzima postojeće podatke.** Ako si Ritam koristio pre naloga, posle ažuriranja svi dosadašnji
  podaci (dani, blokovi, zadaci, beleške, raspored i podešavanja) čekaju vlasnika; u logu piše
  `Ritam: baza ima podatke iz verzije bez naloga — prvi nalog koji se registruje ih preuzima.`, a uz otvorenu
  registraciju i upozorenje `Ritam: PAŽNJA — registracija je otvorena, pa SVE te podatke dobija PRVI ko napravi
  nalog…`. Zato odmah posle ažuriranja otvori aplikaciju i napravi **svoj** nalog: on dobija sve, ništa se ne briše ni
  ne menja. Svaki sledeći nalog počinje prazan. Ako ne možeš odmah, ažuriraj uz `SIGNUP='code'` i `SIGNUP_CODE='…'` u
  `.env` (nalog tada pravi samo ko zna kod), pa te dve linije ukloni kad napraviš nalog.
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

Server radi na :3000, a Vite sa hot reload-om na http://localhost:5173. Napravi nalog na ekranu prijave (email +
lozinka; registracija je podrazumevano otvorena). Bez `HOST` server sluša samo na ovoj mašini (127.0.0.1); za
pristup sa telefona u istoj mreži pokreni produkcijski server sa `HOST=0.0.0.0 npm start` (posle `npm run build`).
Ako postojeća baza (`./data`) ima podatke iz verzije bez naloga, prvi nalog ih preuzima.

Ostale komande: `npm run typecheck`, `npm run build`, `npm start` (produkcijski server, servira `dist/web`).

Test svih API ruta (`scripts/smoke.mjs`) se pokreće samo na posebnoj, privremenoj instanci (nikad na pravoj): pravi
svoje naloge, a prvi nalog na serveru bi preuzeo podatke iz verzije bez naloga. Proverava registraciju, prijavu,
istek i obnovu tokena, rotaciju refresh tokena, odjavu, promenu lozinke, ograničenja pokušaja, sve funkcije
aplikacije (kao nalog A) i potpunu odvojenost podataka dva naloga. Kratak `ACCESS_TOKEN_TTL_SEC` i
`REFRESH_RACE_GRACE_SEC` (isti broj za server i test) skraćuju čekanje u proverama isteka i ponovo upotrebljenog tokena.
Glavna instanca ima podrazumevanu, otvorenu registraciju. Registraciju uz kod proverava uz drugu instancu sa
`SIGNUP=code` (`SMOKE_CODE_URL`, isti `SIGNUP_CODE` za server i test), a zatvorenu uz treću sa `SIGNUP=closed`
(`SMOKE_CLOSED_URL`). Svaku instancu uvek pokreni sa novim, praznim `DATA_DIR`:

```bash
DATA_DIR=/tmp/ritam-test PORT=3999 ACCESS_TOKEN_TTL_SEC=3 REFRESH_RACE_GRACE_SEC=2 npm start
DATA_DIR=/tmp/ritam-code PORT=3998 SIGNUP=code SIGNUP_CODE=x npm start
DATA_DIR=/tmp/ritam-closed PORT=3997 SIGNUP=closed npm start
BASE_URL=http://localhost:3999 SMOKE_CODE_URL=http://localhost:3998 SIGNUP_CODE=x \
  SMOKE_CLOSED_URL=http://localhost:3997 REFRESH_RACE_GRACE_SEC=2 node scripts/smoke.mjs
```

Na kraju piše `Ukupno: N PASS, 0 FAIL`. Bez dodatnih instanci (bez `SMOKE_CODE_URL` / `SMOKE_CLOSED_URL`) te provere
se preskaču, pa zbir ima `1 SKIP` ili `2 SKIP` i manje PASS-ova — to nije greška. Ceo test može da ide i na instanci
koja traži kod (`BASE_URL` instance sa `SIGNUP=code SIGNUP_CODE=x`, uz `SIGNUP_CODE=x` za test): tada svi nalozi testa
nastaju uz kod.

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

Aplikacija je jedan Docker kontejner sa jednim volumenom (`/data`). Jedina obavezna env promenljiva je
`SESSION_SECRET`; lozinke ili koda aplikacije nema. Registracija je podrazumevano otvorena (email + lozinka), pa:
odmah posle prvog pokretanja otvori sajt i napravi svoj nalog. **Preporučeno za javni server:** kad napraviš svoje
naloge (i naloge ukućana), zatvori registraciju sa `SIGNUP=closed` (vidi "Nalozi"), jer inače svako ko nađe sajt može
da napravi nalog i puni disk servera. PWA na telefonu traži HTTPS.

### Opcija A: Railway (najlakše, bez održavanja servera)

1. Postavi projekat na GitHub kao privatni repo.
2. Na railway.com napravi projekat sa opcijom "Deploy from GitHub repo". Railway sam prepozna `Dockerfile`.
3. U servisu dodaj **Volume** sa mount putanjom `/data`.
4. U **Variables** postavi `SESSION_SECRET` (`openssl rand -hex 32`, bar 32 znaka). Dodaj i `RAILWAY_RUN_UID=0`:
   Railway volumen pripada root-u, a aplikacija u kontejneru inače radi kao korisnik `node` i ne bi mogla da upiše
   bazu. Dodaj i `TRUST_PROXY=1`: zahtevi stižu preko Railway proxy-ja, pa se adresa klijenta (za ograničenje
   pokušaja prijave) čita iz `X-Forwarded-For`. `APP_PASSWORD` više ne treba (ako postoji, obriši ga).
5. U **Networking** klikni "Generate Domain". Dobijaš `https://<ime>.up.railway.app`. Otvori ga i odmah napravi svoj
   nalog (**Napravi nalog**: email + lozinka). **Preporučeno:** zatim dodaj `SIGNUP=closed` u Variables (nove naloge
   tada niko ne može da napravi), jer inače svako ko nađe adresu može da napravi nalog i čuva podatke na servisu.
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
   cp .env.example .env && nano .env      # SESSION_SECRET, u jednostrukim navodnicima
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
6. Otvori `https://ritamorg.com`, izaberi **Napravi nalog** i unesi email i lozinku. To je sve — prijava je od tada
   tim email-om i lozinkom, na svakom uređaju.
7. **Preporučeno za javni server:** kad napraviš svoje naloge, zatvori registraciju (inače svako ko nađe sajt može
   da napravi nalog i puni disk servera):

   ```bash
   nano .env                               # dodaj red: SIGNUP='closed'
   docker compose up -d                    # kontejner se ponovo pravi sa novim okruženjem
   docker compose logs ritam | tail -n 3   # … registracija: zatvorena …
   ```

   Za nov nalog kasnije obriši tu liniju iz `.env` i ponovo pokreni `docker compose up -d`.

**Nadogradnja:** pre nadogradnje u aplikaciji preuzmi kopiju (**Podešavanja → Preuzmi kopiju (JSON)**) ili sačuvaj
ceo volumen (vidi "Rezervna kopija"), pa `git pull && docker compose up -d --build`. `APP_PASSWORD` u `.env` iz
ranije verzije više ne treba (docker-compose.yml ga ne prosleđuje), pa ga možeš obrisati. Posle nadogradnje sa
verzije bez naloga **odmah** otvori sajt i napravi svoj nalog — prvi nalog preuzima sve postojeće podatke, a
registracija je otvorena (vidi "Nalozi"; `docker compose logs ritam` tada pokazuje upozorenje `PAŽNJA`). Aplikacija koja je ostala
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
odjavljuju odmah (access token koji je telefon već imao važi još najviše 15 minuta). Promena `SESSION_SECRET` samo
traži nove access tokene i ne odjavljuje uređaje.

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
