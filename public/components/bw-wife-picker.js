// <bw-wife-picker> — choose a Business Wife: the roster, this device's saved
// custom wives, and "Add your own", all as <bw-card>s in one portrait gallery.
//
// Used by Planning Poker (join screen) and Poll (voter identity). The host app
// owns what happens next (join, vote); the picker only owns the choice.
//
//   <bw-wife-picker storage-key="sbw_custom_wives" roster-name="name"
//                   taken-label="Already in the boardroom"></bw-wife-picker>
//
// Attributes
//   storage-key   localStorage key for saved custom wives (this device only)
//   roster-name   "name" (title, e.g. "The Closer") or "first" ("Coco"): which
//                 roster field becomes value.name and is matched by setTaken()
//   taken-label   heading over cards other people already hold
// Properties / methods
//   value         null or { kind: "roster"|"saved"|"custom", name, icon, subtitle, roster? }
//   valid         whether value can be used
//   setTaken(names)   names already in use; their cards move to a greyed section
//   remember(value)   save a custom wife on this device
//   selectName(name)  preselect by name (e.g. the identity in use)
// Events
//   change  every time value changes (detail = value)
//   pick    a ready-made card (roster or saved) was tapped (detail = value)
//
// Light DOM like <bw-card>: shared theme variables, the UI lint and the e2e
// suite all need to see inside. Requires bw-roster.js and bw-card.js.

(function () {
  const SAVED_MAX = 10;
  const ICON_MAX = 19000;         // the server accepts up to 20 000 characters
  const FALLBACK_ICON = "💼";

  const esc = (x) => {
    const d = document.createElement("div");
    d.textContent = x == null ? "" : String(x);
    return d.innerHTML.replace(/"/g, "&quot;");
  };
  const thumb = (src) => (window.bwThumb ? window.bwThumb(src) : src);
  const isPortrait = (s) => /^\/img\/[a-z0-9-]+\.png$/.test(String(s || ""));
  const isSmallData = (s) => /^data:image\/(png|jpe?g|webp);base64,/.test(String(s || "")) && String(s).length <= ICON_MAX;
  const isEmoji = (s) => !!s && !/[:/]/.test(s) && [...s].length <= 8 && s.length <= 32;
  const usableIcon = (s) => isPortrait(s) || isSmallData(s) || isEmoji(s);

  async function shrink(blob) {
    const bmp = await createImageBitmap(blob);
    const canvas = document.createElement("canvas");
    const ctx = canvas.getContext("2d");
    try {
      for (const px of [160, 128, 96, 72]) {
        const scale = Math.min(1, px / Math.max(bmp.width, bmp.height));
        canvas.width = Math.max(1, Math.round(bmp.width * scale));
        canvas.height = Math.max(1, Math.round(bmp.height * scale));
        ctx.drawImage(bmp, 0, 0, canvas.width, canvas.height);
        for (const q of [0.82, 0.7, 0.55]) {
          const url = canvas.toDataURL("image/jpeg", q);
          if (url.length <= ICON_MAX) return url;
        }
      }
    } finally {
      bmp.close();
    }
    throw new Error("That image is too detailed. Try another.");
  }

  class BwWifePicker extends HTMLElement {
    connectedCallback() {
      if (this._built) return;
      this._built = true;
      this._taken = new Set();
      this._mode = null;          // "roster" | "saved" | "custom"
      this._roster = null;
      this._picture = null;       // custom picture: data URL or /img path
      this.classList.add("bw-wife-picker");
      this.innerHTML = `
        <div class="bwp-saved" data-testid="saved-wrap" hidden>
          <h3 class="bwp-h bwp-h--gold">Yours</h3>
          <div class="bwp-grid" data-testid="saved-grid"></div>
        </div>
        <div class="bwp-grid" data-testid="name-grid"></div>
        <div class="bwp-custom" data-testid="custom-panel" hidden>
          <div class="bwp-field">
            <label><span>Display name</span><input data-testid="custom-name" type="text" maxlength="24" placeholder="Your Business Wife name" autocomplete="off"></label>
          </div>
          <div class="bwp-field">
            <label><span>Subtitle <span class="bwp-opt">(optional)</span></span><input data-testid="custom-subtitle" type="text" maxlength="40" placeholder="Closes deals before lunch" autocomplete="off"></label>
          </div>
          <div class="bwp-field">
            <span class="bwp-label">Picture <span class="bwp-opt">(optional)</span></span>
            <div class="bwp-preview" data-testid="custom-preview"></div>
            <div class="bwp-avatars" data-testid="avatar-grid"></div>
            <div class="bwp-pic-row">
              <label class="bwp-btn bwp-file" data-testid="custom-upload-btn">Upload
                <input data-testid="custom-file" type="file" accept="image/png,image/jpeg,image/webp">
              </label>
              <input data-testid="custom-url" type="url" placeholder="or paste an image URL" autocomplete="off">
              <button type="button" class="bwp-btn" data-testid="custom-url-btn">Use</button>
            </div>
          </div>
          <div class="bwp-err" data-testid="custom-error" role="alert"></div>
        </div>
        <div class="bwp-taken" data-testid="taken-wrap" hidden>
          <h3 class="bwp-h"></h3>
          <div class="bwp-grid" data-testid="taken-grid"></div>
        </div>`;
      const q = (t) => this.querySelector(`[data-testid="${t}"]`);
      this.$ = { savedWrap: q("saved-wrap"), saved: q("saved-grid"), grid: q("name-grid"), panel: q("custom-panel"),
        name: q("custom-name"), subtitle: q("custom-subtitle"), preview: q("custom-preview"), avatars: q("avatar-grid"),
        file: q("custom-file"), url: q("custom-url"), urlBtn: q("custom-url-btn"), err: q("custom-error"),
        takenWrap: q("taken-wrap"), taken: q("taken-grid") };
      this.$.takenWrap.querySelector("h3").textContent = this.getAttribute("taken-label") || "Already taken";

      this._rosterCards = (window.BW_ROSTER || []).map((r) => {
        const card = this._card({ name: r.first, subtitle: r.name, img: thumb(r.img), icon: r.icon, testid: "pick" });
        card.dataset.name = r.name;
        card.dataset.first = r.first;
        card.setAttribute("title", r.first + " — " + r.name);
        card.addEventListener("select", () => this._pickRoster(r, card));
        card._key = this._rosterKey(r).toLowerCase();
        this.$.grid.appendChild(card);
        return card;
      });

      const add = document.createElement("bw-card");
      add.setAttribute("variant", "add");
      add.setAttribute("name", "Add your own");
      add.setAttribute("icon", "+");
      add.dataset.testid = "custom-wife";
      add.addEventListener("select", () => this._setOpen(!this._open));
      this.$.add = add;
      this.$.grid.appendChild(add);

      for (const r of window.BW_ROSTER || []) {
        const b = document.createElement("button");
        b.type = "button";
        b.className = "bwp-avatar";
        b.dataset.testid = "avatar-pick";
        b.dataset.img = r.img;
        b.title = r.first;
        b.innerHTML = `<img src="${esc(thumb(r.img))}" alt="">`;
        b.onclick = () => { this._picture = r.img; this._custom(); };
        this.$.avatars.appendChild(b);
      }

      this.$.name.addEventListener("input", () => { if (this.$.name.value.trim()) this._custom(); else this._emit(); });
      this.$.subtitle.addEventListener("input", () => { if (this._mode === "custom") this._emit(); });
      this.$.file.addEventListener("change", async () => {
        const f = this.$.file.files && this.$.file.files[0];
        if (f) await this._usePicture(f);
      });
      this.$.urlBtn.onclick = () => this._useUrl();
      this.$.url.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); this._useUrl(); } });

      this._renderSaved();
      this._paintPreview();
    }

    // ---------- public ----------
    get value() {
      if (this._mode === "roster" && this._roster) {
        return { kind: "roster", roster: this._roster, name: this._rosterKey(this._roster), icon: this._rosterIcon(this._roster), subtitle: "" };
      }
      if (this._mode === "saved" || this._mode === "custom") {
        const name = this.$.name.value.replace(/\s+/g, " ").trim().slice(0, 24);
        if (!name) return null;
        const icon = usableIcon(this._picture) ? this._picture : FALLBACK_ICON;
        return { kind: this._mode, name, icon, subtitle: this.$.subtitle.value.replace(/\s+/g, " ").trim().slice(0, 40) };
      }
      return null;
    }

    get valid() {
      const v = this.value;
      return !!(v && v.name && !this._taken.has(v.name.toLowerCase()));
    }

    setTaken(names) {
      this._taken = new Set([...names].map((n) => String(n).toLowerCase()));
      let any = false;
      for (const card of this._rosterCards) {
        const isTaken = this._taken.has(card._key);
        if (isTaken) {
          card.classList.add("taken");
          card.classList.remove("sel");
          card.dataset.testid = "pick-taken";
          this.$.taken.appendChild(card);
          any = true;
          if (this._mode === "roster" && this._rosterKey(this._roster).toLowerCase() === card._key) { this._mode = null; this._roster = null; this._emit(); }
        } else if (card.classList.contains("taken")) {
          card.classList.remove("taken");
          card.dataset.testid = "pick";
          this.$.grid.insertBefore(card, this._nextRosterSibling(card));
        }
      }
      for (const card of this.$.saved.children) {
        const isTaken = this._taken.has(card._key);
        card.classList.toggle("taken", isTaken);
        card.dataset.testid = isTaken ? "pick-taken" : "saved-pick";
      }
      this.$.takenWrap.hidden = !any;
    }

    remember(v) {
      if (!v || !v.name || v.kind === "roster") return false;
      const key = v.name.toLowerCase();
      const entry = { name: v.name, icon: v.icon, savedAt: Date.now() };
      if (v.subtitle) entry.subtitle = v.subtitle;
      const ok = this._saveList([entry, ...this._loadList().filter((w) => String(w.name).toLowerCase() !== key)]);
      this._renderSaved();
      return ok;
    }

    selectName(name) {
      const key = String(name || "").toLowerCase();
      const saved = [...this.$.saved.children].find((c) => c._key === key);
      if (saved) return saved._choose();
      const r = (window.BW_ROSTER || []).find((x) => this._rosterKey(x).toLowerCase() === key);
      if (r) this._pickRoster(r, this._rosterCards.find((c) => c._key === key), true);
    }

    // ---------- internals ----------
    _rosterKey(r) { return this.getAttribute("roster-name") === "first" ? r.first : r.name; }
    _rosterIcon(r) { return this.getAttribute("roster-name") === "first" ? r.img : r.icon; }

    _nextRosterSibling(card) {
      const order = this._rosterCards;
      for (let i = order.indexOf(card) + 1; i < order.length; i++) {
        if (order[i].parentNode === this.$.grid) return order[i];
      }
      return this.$.add;
    }

    _card({ name, subtitle, img, icon, testid }) {
      const b = document.createElement("bw-card");
      b.dataset.testid = testid;
      b.setAttribute("name", name);
      if (subtitle) b.setAttribute("subtitle", subtitle);
      if (img) b.setAttribute("img", img);
      b.setAttribute("icon", icon || FALLBACK_ICON);
      return b;
    }

    _clearSel() {
      this.querySelectorAll("bw-card.sel").forEach((c) => c.classList.remove("sel"));
    }

    _setOpen(open) {
      this._open = open;
      this.$.panel.hidden = !open;
      this.$.add.classList.toggle("is-open", open);
      this.$.add.toggleAttribute("open", open);
      if (open) {
        this.$.err.textContent = "";
        if (!this.$.name.value) this.$.name.focus();
      }
    }

    _pickRoster(r, card, quiet) {
      this._clearSel();
      if (card) card.classList.add("sel");
      this._mode = "roster";
      this._roster = r;
      // The custom fields follow the pick, so "Add your own" starts from her.
      this.$.name.value = r.first;
      this.$.subtitle.value = "";
      this._picture = r.img;
      this._setOpen(false);
      this._paintPreview();
      this._emit();
      if (!quiet) this.dispatchEvent(new CustomEvent("pick", { detail: this.value }));
    }

    _custom() {
      // Editing anything detaches from a roster card: this is now her own wife.
      if (this._mode !== "custom") {
        this._clearSel();
        this._mode = "custom";
        this._roster = null;
      }
      if (!this._open) this._setOpen(true);
      this._paintPreview();
      this._emit();
    }

    async _usePicture(blob) {
      this.$.err.textContent = "";
      try {
        if (!blob.type || !blob.type.startsWith("image/")) throw new Error("Pick an image file.");
        this._picture = await shrink(blob);
        this.$.url.value = "";
        this._custom();
      } catch (e) {
        this.$.err.textContent = e.message || "Could not use that image.";
      }
    }

    async _useUrl() {
      const url = this.$.url.value.trim();
      if (!/^https?:\/\//i.test(url)) { this.$.err.textContent = "Paste an http(s) image link."; return; }
      try {
        const res = await fetch(url, { mode: "cors" });
        if (!res.ok) throw new Error();
        await this._usePicture(await res.blob());
      } catch {
        // Pictures are stored with the seat, never hot-linked, so a site that
        // will not share its image cannot be used directly.
        this.$.err.textContent = "That site won't share the image. Save it and upload it instead.";
      }
    }

    _paintPreview() {
      const src = this._picture;
      this.$.preview.innerHTML = usableIcon(src) && !isEmoji(src)
        ? `<img src="${esc(isPortrait(src) ? thumb(src) : src)}" alt="">`
        : `<span class="bwp-ph">${FALLBACK_ICON}</span><span class="bwp-hint">Pick a portrait or upload one</span>`;
      this.$.avatars.querySelectorAll(".bwp-avatar").forEach((b) => b.classList.toggle("sel", b.dataset.img === src));
    }

    _emit() {
      this.dispatchEvent(new CustomEvent("change", { detail: this.value }));
    }

    // ---------- saved wives (this device only) ----------
    _loadList() {
      const key = this.getAttribute("storage-key");
      if (!key) return [];
      try {
        const list = JSON.parse(localStorage.getItem(key) || "[]");
        return Array.isArray(list) ? list.filter((w) => w && w.name && w.icon) : [];
      } catch { return []; }
    }

    // Newest first by savedAt, capped. Storage can hold more (older builds,
    // hand edits); the cap must still drop the least recently used.
    _trim(list) {
      return list.slice().sort((a, b) => (Number(b.savedAt) || 0) - (Number(a.savedAt) || 0)).slice(0, SAVED_MAX);
    }

    _saveList(list) {
      const key = this.getAttribute("storage-key");
      if (!key) return false;
      let items = this._trim(list);
      while (items.length) {
        try { localStorage.setItem(key, JSON.stringify(items)); return true; }
        catch { items = items.slice(0, -1); }
      }
      try { localStorage.removeItem(key); } catch {}
      return false;
    }

    _renderSaved() {
      const list = this._trim(this._loadList());
      const selKey = this._mode === "saved" ? this.$.name.value.toLowerCase() : null;
      this.$.saved.innerHTML = "";
      this.$.savedWrap.hidden = !list.length;
      for (const w of list) {
        const icon = String(w.icon);
        const card = this._card({ name: w.name, subtitle: w.subtitle, img: isPortrait(icon) ? thumb(icon) : (isSmallData(icon) || /^data:/.test(icon) ? icon : ""), icon: isEmoji(icon) ? icon : FALLBACK_ICON, testid: "saved-pick" });
        card.dataset.name = w.name;
        card.setAttribute("removable", "");
        card.setAttribute("remove-testid", "saved-remove");
        card._key = String(w.name).toLowerCase();
        card._choose = () => {
          this._clearSel();
          card.classList.add("sel");
          this._mode = "saved";
          this._roster = null;
          this.$.name.value = w.name;
          this.$.subtitle.value = w.subtitle || "";
          this._picture = icon;
          this._setOpen(false);
          this._paintPreview();
          this._emit();
        };
        card.addEventListener("select", () => {
          card._choose();
          this.dispatchEvent(new CustomEvent("pick", { detail: this.value }));
        });
        card.addEventListener("remove", () => this._forget(w.name));
        if (selKey && card._key === selKey) card.classList.add("sel");
        if (this._taken.has(card._key)) { card.classList.add("taken"); card.dataset.testid = "pick-taken"; }
        this.$.saved.appendChild(card);
      }
      this._upgradeOld(list);
    }

    // Older builds stored ~180 KB uploads and hot-linked URLs. Shrink the
    // former once; the latter fall back to the briefcase.
    async _upgradeOld(list) {
      if (this._upgrading) return;
      const stale = list.filter((w) => !usableIcon(w.icon));
      if (!stale.length) return;
      this._upgrading = true;
      let changed = false;
      for (const w of stale) {
        try {
          w.icon = /^data:image\//.test(w.icon) ? await shrink(await (await fetch(w.icon)).blob()) : FALLBACK_ICON;
        } catch { w.icon = FALLBACK_ICON; }
        changed = true;
      }
      this._upgrading = false;
      if (changed) {
        const fixed = new Map(stale.map((w) => [w.name, w.icon]));
        this._saveList(this._loadList().map((w) => (fixed.has(w.name) ? { ...w, icon: fixed.get(w.name) } : w)));
        this._renderSaved();
      }
    }

    _forget(name) {
      const key = String(name).toLowerCase();
      this._saveList(this._loadList().filter((w) => String(w.name).toLowerCase() !== key));
      if (this._mode === "saved" && this.$.name.value.toLowerCase() === key) {
        this._mode = null;
        this.$.name.value = "";
        this.$.subtitle.value = "";
        this._picture = null;
        this._paintPreview();
        this._emit();
      }
      this._renderSaved();
    }
  }

  if (!customElements.get("bw-wife-picker")) customElements.define("bw-wife-picker", BwWifePicker);
})();
