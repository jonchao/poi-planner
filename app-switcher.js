/*!
 * <app-switcher>: a reusable "all apps" button that opens Jon's app dashboard.
 *
 * Usage (any web page or framework):
 *   <script src="app-switcher.js" defer></script>
 *   <app-switcher></app-switcher>
 *
 * Optional attributes:
 *   href    where it goes          (default: https://jonchao.github.io/My-Dashboard/)
 *   label   tooltip / screen-reader text  (default: "All apps")
 *   target  "_self" or "_blank"    (default: "_self")
 *   size    button size in px      (default: 36)
 *
 * Styling: the icon uses the surrounding text color (CSS `color`). Optional CSS variables:
 *   --app-switcher-hover-bg   background on hover/focus  (default: translucent gray)
 *   --app-switcher-radius     corner radius              (default: 8px)
 *   --app-switcher-focus      keyboard focus ring color  (default: currentColor)
 */
(() => {
  const DEFAULT_HREF = "https://jonchao.github.io/My-Dashboard/";
  if (customElements.get("app-switcher")) return;

  const STYLE = `
    :host { display: inline-flex; vertical-align: middle; }
    a {
      display: grid; place-items: center;
      width: var(--_size); height: var(--_size);
      border-radius: var(--app-switcher-radius, 8px);
      color: inherit; text-decoration: none; -webkit-tap-highlight-color: transparent;
      transition: background-color .15s ease, transform .15s ease;
    }
    a:hover, a:focus-visible { background: var(--app-switcher-hover-bg, rgba(128, 128, 128, .16)); }
    a:active { transform: scale(.94); }
    a:focus-visible { outline: 2px solid var(--app-switcher-focus, currentColor); outline-offset: 2px; }
    svg { width: 20px; height: 20px; fill: currentColor; display: block; }
    @media (prefers-reduced-motion: reduce) { a { transition: none; } a:active { transform: none; } }
  `;

  // 3 x 3 grid of dots: the familiar "app launcher" symbol.
  const DOTS = [5, 12, 19].flatMap((y) => [5, 12, 19].map((x) => `<circle cx="${x}" cy="${y}" r="2.2"/>`)).join("");

  class AppSwitcher extends HTMLElement {
    static get observedAttributes() { return ["href", "label", "target", "size"]; }

    constructor() {
      super();
      this.attachShadow({ mode: "open" });
    }

    connectedCallback() { this.render(); }
    attributeChangedCallback() { if (this.isConnected) this.render(); }

    render() {
      const href = this.getAttribute("href") || DEFAULT_HREF;
      const label = this.getAttribute("label") || "All apps";
      const target = this.getAttribute("target") || "_self";
      const size = Math.max(24, parseInt(this.getAttribute("size") || "36", 10) || 36);

      const style = document.createElement("style");
      style.textContent = STYLE;
      const link = document.createElement("a");
      link.setAttribute("part", "button");
      link.href = href;
      link.target = target;
      if (target === "_blank") link.rel = "noopener";
      link.title = label;
      link.setAttribute("aria-label", label);
      link.style.setProperty("--_size", `${size}px`);
      link.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">${DOTS}</svg>`;
      this.shadowRoot.replaceChildren(style, link);
    }
  }

  customElements.define("app-switcher", AppSwitcher);
})();
