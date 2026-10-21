// <bw-card> — the Business Wife portrait card.
//
// One card, used everywhere a person is shown as a pickable portrait: the
// boardroom roster, this device's saved custom wives, the taken section, and
// the "Add your own" slot. Before this existed each caller hand-rolled its own
// `.pick` markup, so changing the card meant finding every copy.
//
// Light DOM on purpose: the apps share one CSS custom-property theme, the UI
// lint walks the rendered page, and Playwright locates by [data-testid]. A
// shadow root would hide the card from all three.
//
//   <bw-card data-testid="pick" data-first="Coco" name="Coco"
//            subtitle="The Closer" img="/img/thumb/closer.jpg" icon="👠">
//   </bw-card>
//
// State lives in classes (`sel`, `taken`) and `data-testid` (`pick`,
// `pick-taken`, `saved-pick`) because that is what the e2e suite asserts on.
// Events: `select` (tapped unless taken) and `remove` (× tapped).
//
// See bw-card.css for the styling; include both files from any app.

class BwCard extends HTMLElement {
  static get observedAttributes() {
    return ["name", "subtitle", "img", "icon", "variant", "removable", "framed", "title"];
  }

  connectedCallback() {
    this.render();
  }

  attributeChangedCallback() {
    if (this.isConnected) this.render();
  }

  get state() { return this.classList.contains("sel") ? "sel" : this.classList.contains("taken") ? "taken" : ""; }
  set state(v) {
    this.classList.toggle("sel", v === "sel");
    this.classList.toggle("taken", v === "taken");
    this.setAttribute("tabindex", v === "taken" ? "-1" : "0");
  }

  get img() { return this.getAttribute("img") || ""; }
  set img(v) { v ? this.setAttribute("img", v) : this.removeAttribute("img"); }

  get name() { return this.getAttribute("name") || ""; }
  set name(v) { this.setAttribute("name", v || ""); }

  render() {
    const variant = this.getAttribute("variant") || "pick";
    const wasSel = this.classList.contains("sel");
    const wasTaken = this.classList.contains("taken");
    const name = this.name;
    const subtitle = this.getAttribute("subtitle") || "";
    const icon = this.getAttribute("icon") || "❔";
    const src = this.img;
    const label = this.getAttribute("title") || (subtitle ? name + " — " + subtitle : name);

    this.classList.add("pick", "bw-card", "bw-card--" + variant);
    if (variant === "add") this.classList.add("bw-card--add");
    this.setAttribute("role", "button");
    this.setAttribute("tabindex", wasTaken ? "-1" : "0");
    if (label) this.setAttribute("aria-label", label);

    const picHtml = `<img class="pic" src="${escapeAttr(src)}" alt="" data-fb="${escapeAttr(icon)}">`;
    // `framed` marks a raw upload: the frame overlay lives in CSS (.bw-framed),
    // not in the image. Stock portraits have their frame baked into the asset.
    const media = src
      ? (this.hasAttribute("framed") ? `<span class="bw-framed">${picHtml}</span>` : picHtml)
      : `<span class="ico" aria-hidden="true">${escapeHtml(icon)}</span>`;

    const who = variant === "add"
      ? `<span class="who">${escapeHtml(name || "Add your own")}</span>`
      : `<span class="who">${escapeHtml(name)}${subtitle ? ` <span class="ttl">${escapeHtml(subtitle)}</span>` : ""}</span>`;

    const remove = this.hasAttribute("removable")
      ? `<span class="rm" role="button" tabindex="0" data-testid="${escapeAttr(this.getAttribute("remove-testid") || "card-remove")}" aria-label="Remove ${escapeAttr(name)}">×</span>`
      : "";

    this.innerHTML = media + who + remove;

    const pic = this.querySelector("img.pic");
    if (pic) {
      pic.onerror = () => {
        const s = document.createElement("span");
        s.className = "ico";
        s.textContent = pic.dataset.fb || "❔";
        (pic.closest(".bw-framed") || pic).replaceWith(s);
      };
    }

    const rm = this.querySelector(".rm");
    if (rm) {
      rm.onclick = (e) => { e.stopPropagation(); this.dispatchEvent(new CustomEvent("remove", { bubbles: true })); };
      rm.onkeydown = (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); e.stopPropagation(); rm.click(); }
      };
    }

    if (!this._wired) {
      const emit = () => {
        if (this.classList.contains("taken")) return;
        this.dispatchEvent(new CustomEvent("select", { bubbles: true }));
      };
      // addEventListener, not onclick: callers own `onclick` on this element.
      this.addEventListener("click", emit);
      this.addEventListener("keydown", (e) => {
        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); emit(); }
      });
      this._wired = true;
    }
  }
}

function escapeHtml(x) {
  const d = document.createElement("div");
  d.textContent = x == null ? "" : String(x);
  return d.innerHTML;
}

function escapeAttr(x) {
  return escapeHtml(x).replace(/"/g, "&quot;");
}

if (!customElements.get("bw-card")) customElements.define("bw-card", BwCard);
