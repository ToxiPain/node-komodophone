// node-komodophone/index.js
import EventEmitter from "events";
import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";

function esperar(ms){ return new Promise(r=>setTimeout(r,ms)); }

export default class KomodoPhone extends EventEmitter {
  constructor(opts = {}) {
    super();
    this.browser = null;
    this.page = null;
    this.sessionPath = opts.sessionPath || path.resolve("session.json");
    this.headless = opts.headless ?? true;
    this.lastNumero = null;
    this._running = false;
  }

  async init() {
    try {
      this.browser = await puppeteer.launch({
        headless: this.headless,
        defaultViewport: null,
        args: ["--no-sandbox", "--disable-setuid-sandbox"]
      });
      this.page = await this.browser.newPage();
      this.emit("log", "browser-launched");

      // load session if exists
      if (!fs.existsSync(this.sessionPath)) {
        this.emit("log", `session.json not found at ${this.sessionPath}`);
      } else {
        const raw = JSON.parse(fs.readFileSync(this.sessionPath));
        const { cookies = [], localStorage = {} } = raw;
        for (const c of cookies) await this.page.setCookie(c);
        await this.page.goto("https://app.smsvirtual.org", { waitUntil: "domcontentloaded" });
        await this.page.evaluate((storage) => {
          for (const k in storage) localStorage.setItem(k, storage[k]);
        }, localStorage);
        this.emit("log", "session-loaded");
      }

      this._running = true;
      this.emit("ready");
      return true;
    } catch (e) {
      this.emit("error", e);
      throw e;
    }
  }

  async _screenshot(name){
    try {
      const dir = path.resolve("capturas");
      if(!fs.existsSync(dir)) fs.mkdirSync(dir);
      const file = path.join(dir, name + ".png");
      await esperar(1500);
      await this.page.screenshot({ path: file, fullPage: true });
      this.emit("log", `screenshot:${file}`);
    } catch(e){
      this.emit("log", "screenshot-failed");
    }
  }

  async activateCountry(country) {
    if (!this._running) throw new Error("KomodoPhone not initialized. Call init() first.");
    try {
      await this.page.goto("https://app.smsvirtual.org", { waitUntil: "networkidle2" });

      // click Whatsapp entry (robusto: intenta varios selectores)
      await this.page.waitForSelector('text/Whatsapp', { timeout: 7000 });
      await this.page.click('text/Whatsapp');
      this.emit("log", "clicked-whatsapp");

      // seleccionar país: si es número -> lista local, si es string -> buscar texto exacto
      const paises = ["Indonesia", "Kenya", "Vietnam", "Southafrica", "Canada", "Philippines", "Colombia", "Chile", "Laos", "Nigeria", "Egypt", "Ghana", "Cameroon"];
      let chosen = null;
      if (typeof country === "number") {
        chosen = paises[country] ?? null;
      } else if (typeof country === "string") {
        chosen = country;
      } else {
        throw new Error("country must be index or name");
      }

      if (!chosen) throw new Error("country not found");

      await this.page.waitForSelector(`text/${chosen}`, { timeout: 7000 });
      await this.page.click(`text/${chosen}`);
      this.emit("log", `country-selected:${chosen}`);

      await esperar(1000);
      await this.page.waitForSelector("text/Activate", { timeout: 7000 });
      await this.page.click("text/Activate");
      this.emit("log", "activate-clicked");
      await esperar(1200);

      // detectar popup de error o numero activo
      const errorPromise = this.page.waitForFunction(() => {
        return document.querySelector('[class*="Error"], [class*="error"], [data-open="entercard"], .modal, [class*="Modal"]');
      }, { timeout: 6000 }).then(() => "ERROR").catch(()=>null);

      const numberPromise = this.page.waitForSelector('[class*="PhoneNumber__Wrapper"]', { timeout: 9000 }).then(()=> "ACTIVE").catch(()=>null);
      const resultado = await Promise.race([errorPromise, numberPromise]);

      if (resultado === "ERROR") {
        this.emit("error", new Error("NO AVAILABLE NUMBERS"));
        await this._screenshot(`error_${chosen}`);
        return null;
      }

      if (resultado === "ACTIVE") {
        await esperar(800);
        const numero = await this.page.evaluate(() => {
          const nodos = [...document.querySelectorAll('[class*="PhoneNumber__Wrapper"]')];
          if (!nodos.length) return null;
          const texto = nodos[0].innerText.trim();
          const match = texto.match(/\+\d[\d\s]+/);
          return match ? match[0].replace(/\s+/g, "") : null;
        });

        if (numero) {
          this.lastNumero = numero;
          this.emit("number", numero);
          // lanza detector de SMS en background (no bloquear)
          this._startListeningSms();
          return numero;
        } else {
          await this._screenshot(`no_number_${chosen}`);
          this.emit("error", new Error("NO_NUMBER_EXTRACTED"));
          return null;
        }
      }

      this.emit("log", "no result after activation");
      await this._screenshot(`timeout_${chosen}`);
      return null;

    } catch (e) {
      this.emit("error", e);
      throw e;
    }
  }

  // metodo privado: corre en background y emite 'code' cuando detecta texto en <pre>
  async _startListeningSms() {
    if (!this.page) return;
    // si ya hay un listener, no duplicar
    if (this._smsListening) return;
    this._smsListening = true;
    this.emit("log", "sms-listener-started");

    while (this._smsListening) {
      try {
        const mensaje = await this.page.evaluate(() => {
          const pre = document.querySelector("pre");
          if (!pre) return null;
          const texto = pre.innerText.trim();
          // criterio: tiene "Codigo" o "WhatsApp" o patrón de 4-8 dígitos/alfanum
          if (!texto) return null;
          if (texto.toLowerCase().includes("codigo") || texto.toLowerCase().includes("whatsapp") || /[0-9]{3,8}/.test(texto)) {
            return texto;
          }
          return null;
        });

        if (mensaje) {
          this.emit("code", mensaje);
          // por defecto detenemos el listener cuando llega código; si quieres seguir, comentar la siguiente línea:
          this._smsListening = false;
          break;
        }
      } catch(e){
        this.emit("log", "sms-listen-eval-error");
      }
      await esperar(2000);
    }

    this._smsListening = false;
    this.emit("log", "sms-listener-stopped");
  }

  async stop() {
    try {
      this._smsListening = false;
      this._running = false;
      if (this.page) await this.page.close().catch(()=>{});
      if (this.browser) await this.browser.close().catch(()=>{});
      this.emit("log", "komodo-stopped");
    } catch (e) {
      this.emit("error", e);
    }
  }
}
