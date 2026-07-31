const parseViewport = (str) =>
  str
    ?.split(/[,;\s]/) // NOTE: technically, only the comma is valid
    ?.filter((x) => x)
    ?.map((x) => x.split("=").map((x) => x.trim()));

const getViewport = (doc, viewport) => {
  // use `viewBox` for SVG
  if (doc.documentElement.localName === "svg") {
    const [, , width, height] = doc.documentElement.getAttribute("viewBox")?.split(/\s/) ?? [];
    return { width, height };
  }

  // get `viewport` `meta` element
  const meta = parseViewport(doc.querySelector('meta[name="viewport"]')?.getAttribute("content"));
  if (meta) return Object.fromEntries(meta);

  // fallback to book's viewport
  if (typeof viewport === "string") return parseViewport(viewport);
  if (viewport?.width && viewport.height) return viewport;

  // if no viewport (possibly with image directly in spine), get image size
  const img = doc.querySelector("img");
  if (img) return { width: img.naturalWidth, height: img.naturalHeight };

  // just show *something*, i guess...
  console.warn(new Error("Missing viewport properties"));
  return { width: 1000, height: 2000 };
};

export class FixedLayout extends HTMLElement {
  static observedAttributes = ["zoom", "zoom-factor", "spread", "flow"];
  #root = this.attachShadow({ mode: "closed" });
  #observer = new ResizeObserver(() => this.#render());
  #spreads;
  #index = -1;
  defaultViewport;
  spread;
  #portrait = false;
  #left;
  #right;
  #center;
  #side;
  #zoom;
  #zoomFactor = 1;
  #scrollStack;
  #scrollSlots = [];
  #scrollRows = [];
  #continuousFrames = new Map();
  #continuousLoads = new Map();
  #continuousGeneration = 0;
  #continuousIndex = -1;
  #continuousInitialized = false;
  #locationIndex = -1;
  #locationFraction = 0;
  #scrollTimer;
  #modePromise = Promise.resolve();
  constructor() {
    super();

    const sheet = new CSSStyleSheet();
    this.#root.adoptedStyleSheets = [sheet];
    sheet.replaceSync(`:host {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: safe center;
            align-items: safe center;
            overflow: auto;
        }
        :host([flow="scrolled"]) {
            display: block;
            box-sizing: border-box;
            padding: 20px 0 32px;
            overflow: auto;
            overscroll-behavior: contain;
            scrollbar-gutter: stable;
        }
        #scroll-stack {
            display: flex;
            flex-direction: column;
            align-items: center;
            gap: 16px;
            width: max-content;
            min-width: 100%;
            margin: 0 auto;
        }
        .scroll-row {
            display: flex;
            flex: none;
            align-items: flex-start;
            justify-content: center;
            gap: 16px;
            width: max-content;
        }
        .scroll-slot {
            position: relative;
            flex: none;
            overflow: hidden;
            background: #fff;
            box-shadow: 0 1px 5px rgba(0, 0, 0, .16);
        }
        .scroll-placeholder {
            flex: none;
        }`);

    this.#observer.observe(this);
    this.addEventListener("scroll", () => {
      if (!this.scrolled || !this.#continuousInitialized) return;
      if (this.#scrollTimer) clearTimeout(this.#scrollTimer);
      this.#scrollTimer = setTimeout(() => {
        this.#scrollTimer = null;
        this.#updateContinuousLocation("scroll");
      }, 80);
    });
  }
  attributeChangedCallback(name, oldValue, value) {
    switch (name) {
      case "zoom":
        this.#zoom =
          value !== "fit-width" && value !== "fit-page" ? Number.parseFloat(value) : value;
        this.#render();
        break;
      case "zoom-factor": {
        const parsed = Number.parseFloat(value);
        this.#zoomFactor = Number.isFinite(parsed) && parsed > 0 ? parsed : 1;
        this.#render();
        break;
      }
      case "spread":
        this.spread = value;
        this.#modePromise = this.#applySpreadChange(value);
        break;
      case "flow":
        this.#modePromise = this.#applyFlowChange(value, oldValue);
        break;
    }
  }
  #buildSpreads(book) {
    const { rendition } = book;
    const rtl = book.dir === "rtl";
    const ltr = !rtl;
    if (rendition?.spread === "none") return book.sections.map((section) => ({ center: section }));

    return book.sections.reduce(
      (arr, section, i) => {
        const last = arr[arr.length - 1];
        const { pageSpread } = section;
        const newSpread = () => {
          const spread = {};
          arr.push(spread);
          return spread;
        };
        if (pageSpread === "center") {
          const spread = last.left || last.right ? newSpread() : last;
          spread.center = section;
        } else if (pageSpread === "left") {
          const spread = last.center || last.left || (ltr && i) ? newSpread() : last;
          spread.left = section;
        } else if (pageSpread === "right") {
          const spread = last.center || last.right || (rtl && i) ? newSpread() : last;
          spread.right = section;
        } else if (ltr) {
          if (last.center || last.right) newSpread().left = section;
          else if (last.left || !i) last.right = section;
          else last.left = section;
        } else {
          if (last.center || last.left) newSpread().right = section;
          else if (last.right || !i) last.left = section;
          else last.right = section;
        }
        return arr;
      },
      [{}],
    );
  }
  async #applySpreadChange(value) {
    if (!this.book?.sections?.length) return;
    const location = this.#captureLocation(this.scrolled);
    const initialized = this.scrolled
      ? this.#continuousInitialized
      : location.index >= 0 || this.#locationIndex >= 0;
    if (this.book.rendition) this.book.rendition.spread = value;
    this.#spreads = this.#buildSpreads(this.book);

    if (this.scrolled) {
      this.#continuousGeneration += 1;
      this.#clearRenderedContent();
      await this.#showContinuous(
        location.index >= 0 ? location.index : 0,
        initialized,
        location.fraction,
      );
      return;
    }

    if (location.index < 0) {
      this.#index = -1;
      return;
    }

    const currentSection = this.book.sections[location.index];
    const target = currentSection ? this.getSpreadOf(currentSection) : null;
    this.#index = -1;
    await this.goToSpread(
      target?.index ?? 0,
      target?.side ?? (this.rtl ? "right" : "left"),
      "layout",
    );
  }

  #getPaginatedIndex() {
    const spread = this.#spreads?.[this.#index];
    if (!spread) return -1;
    const section =
      spread?.center ??
      (this.#side === "left" ? (spread.left ?? spread.right) : (spread.right ?? spread.left));
    return this.book.sections.indexOf(section);
  }

  #getContinuousIndexAtViewport() {
    if (!this.#scrollSlots.length) return this.#continuousIndex;

    const hostRect = this.getBoundingClientRect();
    const viewportCenter = hostRect.top + this.clientHeight / 2;
    const currentSlot = this.#scrollSlots[this.#continuousIndex];
    if (currentSlot) {
      const currentRect = currentSlot.getBoundingClientRect();
      if (viewportCenter >= currentRect.top && viewportCenter < currentRect.bottom) {
        return this.#continuousIndex;
      }
    }

    let index = this.#continuousIndex >= 0 ? this.#continuousIndex : 0;
    for (let i = 0; i < this.#scrollSlots.length; i += 1) {
      const slot = this.#scrollSlots[i];
      if (!slot) continue;
      if (viewportCenter < slot.getBoundingClientRect().bottom) return i;
      index = i;
    }
    return index;
  }

  #getContinuousFraction(index) {
    const slot = this.#scrollSlots[index];
    if (!slot) return this.#locationFraction;
    const hostRect = this.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    if (!slotRect.height) return this.#locationFraction;
    return Math.max(0, Math.min(1, (hostRect.top + 20 - slotRect.top) / slotRect.height));
  }

  #setContinuousLocation(index, fraction = 0) {
    const slot = this.#scrollSlots[index];
    if (!slot) return;
    const hostRect = this.getBoundingClientRect();
    const slotRect = slot.getBoundingClientRect();
    const delta = slotRect.top - hostRect.top - 20 + fraction * slotRect.height;
    this.scrollTop = Math.max(0, this.scrollTop + delta);
  }

  async #restoreContinuousLocation(index, fraction = 0) {
    // WebKit may run ResizeObserver callbacks for the newly-created rows after
    // the first scroll assignment. Reapply on the next two frames so the final
    // position is based on settled geometry rather than stale offsetTop values.
    this.#setContinuousLocation(index, fraction);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    this.#setContinuousLocation(index, fraction);
    await new Promise((resolve) => requestAnimationFrame(resolve));
    this.#setContinuousLocation(index, fraction);
  }

  #captureLocation(scrolled = this.scrolled) {
    if (scrolled && this.#continuousInitialized) {
      const index = this.#getContinuousIndexAtViewport();
      if (index >= 0) {
        return { index, fraction: this.#getContinuousFraction(index) };
      }
    }

    if (!scrolled) {
      const index = this.#getPaginatedIndex();
      if (index >= 0) return { index, fraction: 0 };
    }

    return { index: this.#locationIndex, fraction: this.#locationFraction };
  }

  async #applyFlowChange(value, oldValue) {
    if (!this.book?.sections?.length) return;

    const wasScrolled = oldValue === "scrolled";
    const location = this.#captureLocation(wasScrolled);
    const initialized = wasScrolled
      ? this.#continuousInitialized
      : location.index >= 0 || this.#locationIndex >= 0;
    this.#continuousGeneration += 1;
    this.#clearRenderedContent();

    if (value === "scrolled") {
      await this.#showContinuous(
        location.index >= 0 ? location.index : 0,
        initialized,
        location.fraction,
      );
      return;
    }

    this.#continuousInitialized = false;
    this.#continuousIndex = -1;
    this.#spreads = this.#buildSpreads(this.book);
    this.#index = -1;
    if (!initialized || location.index < 0) return;

    const currentSection = this.book.sections[location.index];
    const target = currentSection ? this.getSpreadOf(currentSection) : null;
    await this.goToSpread(
      target?.index ?? 0,
      target?.side ?? (this.rtl ? "right" : "left"),
      "layout",
    );
  }

  #clearRenderedContent() {
    this.#root.replaceChildren();
    this.#left = null;
    this.#right = null;
    this.#center = null;
    this.#scrollStack = null;
    this.#scrollSlots = [];
    this.#scrollRows = [];
    this.#continuousFrames.clear();
    this.#continuousLoads.clear();
  }

  async #createFrame({ index, src: srcOption }, mount = this.#root) {
    const srcOptionIsString = typeof srcOption === "string";
    const src = srcOptionIsString ? srcOption : srcOption?.src;
    const onZoom = srcOptionIsString ? null : srcOption?.onZoom;
    const element = document.createElement("div");
    element.setAttribute("dir", "ltr");
    const iframe = document.createElement("iframe");
    element.append(iframe);
    Object.assign(iframe.style, {
      border: "0",
      display: "none",
      overflow: "hidden",
    });
    // `allow-scripts` is needed for events because of WebKit bug
    // https://bugs.webkit.org/show_bug.cgi?id=218086
    iframe.setAttribute("sandbox", "allow-same-origin allow-scripts");
    iframe.setAttribute("scrolling", "no");
    iframe.setAttribute("part", "filter");
    mount.append(element);
    if (!src) return { blank: true, element, iframe, index };
    return new Promise((resolve) => {
      iframe.addEventListener(
        "load",
        () => {
          const doc = iframe.contentDocument;
          this.dispatchEvent(new CustomEvent("load", { detail: { doc, index } }));
          const { width, height } = getViewport(doc, this.defaultViewport);
          resolve({
            element,
            iframe,
            width: Number.parseFloat(width),
            height: Number.parseFloat(height),
            onZoom,
            index,
          });
        },
        { once: true },
      );
      iframe.src = src;
    });
  }

  get scrolled() {
    return this.getAttribute("flow") === "scrolled";
  }

  get currentLocation() {
    return this.#captureLocation(this.scrolled);
  }

  #resizeContinuousRow(row) {
    const fallbackWidth = Number(this.defaultViewport?.width) || 1000;
    const fallbackHeight = Number(this.defaultViewport?.height) || 1400;
    const realItem = row.items.find(({ slot }) => slot);
    const referenceWidth = Number(realItem?.slot?.dataset.pageWidth) || fallbackWidth;
    const referenceHeight = Number(realItem?.slot?.dataset.pageHeight) || fallbackHeight;
    const dimensions = row.items.map(({ slot }) => ({
      width: Number(slot?.dataset.pageWidth) || referenceWidth,
      height: Number(slot?.dataset.pageHeight) || referenceHeight,
    }));
    const gap = row.items.length > 1 ? 16 * (row.items.length - 1) : 0;
    const contentWidth = dimensions.reduce((sum, { width }) => sum + width, 0);
    const { width } = this.getBoundingClientRect();
    const availableWidth = Math.max(1, width - 40 - gap);
    const scale = (availableWidth / Math.max(1, contentWidth)) * this.#zoomFactor;

    row.items.forEach(({ element, slot }, itemIndex) => {
      const { width: pageWidth, height: pageHeight } = dimensions[itemIndex];
      Object.assign(element.style, {
        width: `${pageWidth * scale}px`,
        height: `${pageHeight * scale}px`,
      });
      if (slot) slot.dataset.scale = String(scale);
    });
    return scale;
  }

  #renderContinuousRow(row) {
    if (!row) return;
    const scale = this.#resizeContinuousRow(row);
    for (const { index } of row.items) {
      const frame = this.#continuousFrames.get(index);
      if (!frame?.iframe || frame.blank) continue;
      if (frame.onZoom) frame.onZoom({ doc: frame.iframe.contentDocument, scale });
      const iframeScale = frame.onZoom ? scale : 1;
      Object.assign(frame.iframe.style, {
        width: `${frame.width * iframeScale}px`,
        height: `${frame.height * iframeScale}px`,
        transform: frame.onZoom ? "none" : `scale(${scale})`,
        transformOrigin: "top left",
        display: "block",
      });
      Object.assign(frame.element.style, {
        width: `${frame.width * scale}px`,
        height: `${frame.height * scale}px`,
        overflow: "hidden",
        display: "block",
      });
    }
  }

  #renderContinuousFrame(frame) {
    if (!frame?.iframe || frame.blank) return;
    const slot = this.#scrollSlots[frame.index];
    if (!slot) return;
    slot.dataset.pageWidth = String(frame.width);
    slot.dataset.pageHeight = String(frame.height);
    this.#renderContinuousRow(this.#scrollRows[Number(slot.dataset.rowIndex)]);
  }

  #renderContinuous() {
    if (!this.#scrollSlots.length) return;
    const anchorSlot = this.#scrollSlots[Math.max(0, this.#continuousIndex)];
    const hostTop = this.getBoundingClientRect().top;
    const anchorOffset = anchorSlot ? anchorSlot.getBoundingClientRect().top - hostTop : 0;

    for (const row of this.#scrollRows) this.#renderContinuousRow(row);

    if (anchorSlot && this.#continuousInitialized) {
      requestAnimationFrame(() => {
        const nextOffset =
          anchorSlot.getBoundingClientRect().top - this.getBoundingClientRect().top;
        this.scrollTop = Math.max(0, this.scrollTop + nextOffset - anchorOffset);
      });
    }
  }

  async #showContinuous(index, initialized, fraction = 0) {
    const generation = this.#continuousGeneration;
    const fallbackWidth = Number(this.defaultViewport?.width) || 1000;
    const fallbackHeight = Number(this.defaultViewport?.height) || 1400;
    const stack = document.createElement("div");
    stack.id = "scroll-stack";

    this.#scrollStack = stack;
    this.#scrollSlots = Array(this.book.sections.length);
    this.#scrollRows = this.#spreads.map((spread, rowIndex) => {
      const rowElement = document.createElement("div");
      rowElement.className = "scroll-row";
      const sections = spread.center ? [spread.center] : [spread.left, spread.right];
      const items = sections.map((section) => {
        const pageIndex = this.book.sections.indexOf(section);
        const element = document.createElement("div");
        if (pageIndex < 0) {
          element.className = "scroll-placeholder";
          rowElement.append(element);
          return { element, index: -1, slot: null };
        }

        element.className = "scroll-slot";
        element.dataset.index = String(pageIndex);
        element.dataset.rowIndex = String(rowIndex);
        element.dataset.pageWidth = String(fallbackWidth);
        element.dataset.pageHeight = String(fallbackHeight);
        this.#scrollSlots[pageIndex] = element;
        rowElement.append(element);
        return { element, index: pageIndex, slot: element };
      });
      const row = { element: rowElement, items };
      stack.append(rowElement);
      return row;
    });
    this.#root.append(stack);
    for (const row of this.#scrollRows) this.#resizeContinuousRow(row);

    const targetIndex = Math.max(0, Math.min(this.book.sections.length - 1, index));
    this.#continuousIndex = initialized ? targetIndex : -1;
    this.#continuousInitialized = initialized;
    await this.#loadContinuousWindow(targetIndex, generation);
    if (generation !== this.#continuousGeneration) return;

    if (initialized) {
      await this.#restoreContinuousLocation(targetIndex, fraction);
      if (generation !== this.#continuousGeneration) return;
      this.#reportLocation("layout");
    }
  }

  async #loadContinuousPage(index, generation = this.#continuousGeneration) {
    if (
      generation !== this.#continuousGeneration ||
      index < 0 ||
      index >= this.book.sections.length ||
      this.#continuousFrames.has(index)
    ) {
      return;
    }
    if (this.#continuousLoads.has(index)) return this.#continuousLoads.get(index);

    const loadPromise = (async () => {
      const src = await this.book.sections[index]?.load?.();
      if (generation !== this.#continuousGeneration || !this.scrolled) return;
      const slot = this.#scrollSlots[index];
      if (!slot) return;

      slot.replaceChildren();
      const frame = await this.#createFrame({ index, src }, slot);
      if (generation !== this.#continuousGeneration || !this.scrolled) {
        frame.element.remove();
        return;
      }
      this.#continuousFrames.set(index, frame);
      this.#renderContinuousFrame(frame);

      if (Math.abs(index - this.#continuousIndex) > 4 && this.#continuousInitialized) {
        frame.element.remove();
        this.#continuousFrames.delete(index);
      }
    })().finally(() => {
      this.#continuousLoads.delete(index);
    });
    this.#continuousLoads.set(index, loadPromise);
    return loadPromise;
  }

  async #loadContinuousWindow(index, generation = this.#continuousGeneration) {
    const start = Math.max(0, index - 2);
    const end = Math.min(this.book.sections.length - 1, index + 3);
    await Promise.all(
      Array.from({ length: end - start + 1 }, (_, offset) =>
        this.#loadContinuousPage(start + offset, generation),
      ),
    );

    if (generation !== this.#continuousGeneration) return;
    for (const [pageIndex, frame] of this.#continuousFrames) {
      if (pageIndex < index - 4 || pageIndex > index + 5) {
        frame.element.remove();
        this.#continuousFrames.delete(pageIndex);
      }
    }
  }

  #updateContinuousLocation(reason) {
    if (!this.scrolled || !this.#continuousInitialized || !this.#scrollSlots.length) return;
    const index = this.#getContinuousIndexAtViewport();
    this.#continuousIndex = index;
    void this.#loadContinuousWindow(index);
    this.#reportLocation(reason);
  }

  async #goToContinuousIndex(index, reason = "navigation") {
    const targetIndex = Math.max(0, Math.min(this.book.sections.length - 1, index));
    this.#continuousInitialized = true;
    this.#continuousIndex = targetIndex;
    await this.#loadContinuousWindow(targetIndex);
    await this.#restoreContinuousLocation(targetIndex, 0);
    this.#locationFraction = 0;
    this.#reportLocation(reason);
  }

  #render(side = this.#side) {
    if (this.scrolled) {
      this.#renderContinuous();
      return;
    }
    if (!side) return;
    const left = this.#left ?? {};
    const right = this.#center ?? this.#right ?? {};
    const target = side === "left" ? left : right;
    const { width, height } = this.getBoundingClientRect();
    const portrait = this.spread !== "both" && this.spread !== "portrait" && height > width;
    this.#portrait = portrait;
    const blankWidth = left.width ?? right.width ?? 0;
    const blankHeight = left.height ?? right.height ?? 0;

    const fitScale =
      typeof this.#zoom === "number" && !Number.isNaN(this.#zoom)
        ? this.#zoom
        : (this.#zoom === "fit-width"
            ? portrait || this.#center
              ? width / (target.width ?? blankWidth)
              : width / ((left.width ?? blankWidth) + (right.width ?? blankWidth))
            : portrait || this.#center
              ? Math.min(
                  width / (target.width ?? blankWidth),
                  height / (target.height ?? blankHeight),
                )
              : Math.min(
                  width / ((left.width ?? blankWidth) + (right.width ?? blankWidth)),
                  height / Math.max(left.height ?? blankHeight, right.height ?? blankHeight),
                )) || 1;
    const scale =
      typeof this.#zoom === "number" && !Number.isNaN(this.#zoom)
        ? fitScale
        : fitScale * this.#zoomFactor;

    const transform = (frame) => {
      const { element, iframe, width, height, blank, onZoom } = frame;
      if (!iframe) return;
      if (onZoom) onZoom({ doc: frame.iframe.contentDocument, scale });
      const iframeScale = onZoom ? scale : 1;
      Object.assign(iframe.style, {
        width: `${width * iframeScale}px`,
        height: `${height * iframeScale}px`,
        transform: onZoom ? "none" : `scale(${scale})`,
        transformOrigin: "top left",
        display: blank ? "none" : "block",
      });
      Object.assign(element.style, {
        width: `${(width ?? blankWidth) * scale}px`,
        height: `${(height ?? blankHeight) * scale}px`,
        overflow: "hidden",
        display: "block",
        flexShrink: "0",
        marginBlock: "auto",
      });
      if (portrait && frame !== target) {
        element.style.display = "none";
      }
    };
    if (this.#center) {
      transform(this.#center);
    } else {
      transform(left);
      transform(right);
    }
  }
  async #showSpread({ left, right, center, side }) {
    this.#clearRenderedContent();
    this.#left = null;
    this.#right = null;
    this.#center = null;
    if (center) {
      this.#center = await this.#createFrame(center);
      this.#side = "center";
      this.#render();
    } else {
      this.#left = await this.#createFrame(left);
      this.#right = await this.#createFrame(right);
      this.#side = this.#left.blank ? "right" : this.#right.blank ? "left" : side;
      this.#render();
    }
  }
  #goLeft() {
    if (this.#center || this.#left?.blank) return;
    if (this.#portrait && this.#left?.element?.style?.display === "none") {
      this.#side = "left";
      this.#render();
      this.#reportLocation("page");
      return true;
    }
  }
  #goRight() {
    if (this.#center || this.#right?.blank) return;
    if (this.#portrait && this.#right?.element?.style?.display === "none") {
      this.#side = "right";
      this.#render();
      this.#reportLocation("page");
      return true;
    }
  }
  open(book) {
    this.book = book;
    const { rendition } = book;
    this.spread = rendition?.spread;
    this.defaultViewport = rendition?.viewport;

    const rtl = book.dir === "rtl";
    this.rtl = rtl;

    this.#spreads = this.#buildSpreads(book);
  }
  get index() {
    if (this.scrolled) return this.#continuousIndex;
    return this.#getPaginatedIndex();
  }
  get primaryIndex() {
    return this.index;
  }
  #reportLocation(reason) {
    const index = this.index;
    if (index < 0) return;
    let fraction = 0;
    let size = 1;
    if (this.scrolled) {
      const slot = this.#scrollSlots[index];
      if (slot?.offsetHeight) {
        fraction = this.#getContinuousFraction(index);
        size = Math.max(0, Math.min(1, this.clientHeight / slot.offsetHeight));
      }
    }
    this.#locationIndex = index;
    this.#locationFraction = fraction;
    this.dispatchEvent(
      new CustomEvent("relocate", {
        detail: { reason, range: null, index, fraction, size },
      }),
    );
  }
  getSpreadOf(section) {
    const spreads = this.#spreads;
    for (let index = 0; index < spreads.length; index++) {
      const { left, right, center } = spreads[index];
      if (left === section) return { index, side: "left" };
      if (right === section) return { index, side: "right" };
      if (center === section) return { index, side: "center" };
    }
  }
  async goToSpread(index, side, reason) {
    if (index < 0 || index > this.#spreads.length - 1) return;
    if (index === this.#index) {
      this.#render(side);
      return;
    }
    this.#index = index;
    const spread = this.#spreads[index];
    if (spread.center) {
      const index = this.book.sections.indexOf(spread.center);
      const src = await spread.center?.load?.();
      await this.#showSpread({ center: { index, src } });
    } else {
      const indexL = this.book.sections.indexOf(spread.left);
      const indexR = this.book.sections.indexOf(spread.right);
      const srcL = await spread.left?.load?.();
      const srcR = await spread.right?.load?.();
      const left = { index: indexL, src: srcL };
      const right = { index: indexR, src: srcR };
      await this.#showSpread({ left, right, side });
    }
    this.#reportLocation(reason);
  }
  async select(target) {
    await this.goTo(target);
    // TODO
  }
  async restoreLocation(location, reason = "layout") {
    await this.#modePromise;
    if (!location || typeof location.index !== "number") return;
    const index = Math.max(0, Math.min(this.book.sections.length - 1, location.index));
    if (this.scrolled) {
      this.#continuousInitialized = true;
      this.#continuousIndex = index;
      await this.#loadContinuousWindow(index);
      await this.#restoreContinuousLocation(index, location.fraction ?? 0);
      this.#reportLocation(reason);
      return;
    }

    const section = this.book.sections[index];
    const spread = section ? this.getSpreadOf(section) : null;
    if (!spread) return;
    await this.goToSpread(spread.index, spread.side, reason);
  }
  async goTo(target) {
    await this.#modePromise;
    const { book } = this;
    const resolved = await target;
    if (!resolved || typeof resolved.index !== "number") return;
    if (this.scrolled) {
      await this.#goToContinuousIndex(resolved.index);
      return;
    }
    const section = book.sections[resolved.index];
    if (!section) return;
    const spread = this.getSpreadOf(section);
    if (!spread) return;
    const { index, side } = spread;
    await this.goToSpread(index, side);
  }
  async next(distance) {
    await this.#modePromise;
    if (this.scrolled) {
      if (!this.#continuousInitialized) return this.#goToContinuousIndex(0, "page");
      const amount = Number.isFinite(distance) ? distance : Math.max(1, this.clientHeight - 96);
      this.scrollBy({ top: amount, behavior: "smooth" });
      return;
    }
    const s = this.rtl ? this.#goLeft() : this.#goRight();
    if (!s) return this.goToSpread(this.#index + 1, this.rtl ? "right" : "left", "page");
  }
  async prev(distance) {
    await this.#modePromise;
    if (this.scrolled) {
      if (!this.#continuousInitialized) return this.#goToContinuousIndex(0, "page");
      const amount = Number.isFinite(distance) ? distance : Math.max(1, this.clientHeight - 96);
      this.scrollBy({ top: -amount, behavior: "smooth" });
      return;
    }
    const s = this.rtl ? this.#goRight() : this.#goLeft();
    if (!s) return this.goToSpread(this.#index - 1, this.rtl ? "left" : "right", "page");
  }
  getContents() {
    if (this.scrolled) {
      return Array.from(this.#continuousFrames, ([index, frame]) => ({
        doc: frame.iframe.contentDocument,
        index,
      })).sort((a, b) => a.index - b.index);
    }
    return [this.#left, this.#right, this.#center]
      .filter((frame) => frame?.iframe && !frame.blank)
      .map((frame) => ({ doc: frame.iframe.contentDocument, index: frame.index }));
  }
  destroy() {
    this.#observer.unobserve(this);
    this.#continuousGeneration += 1;
    if (this.#scrollTimer) clearTimeout(this.#scrollTimer);
    this.#clearRenderedContent();
  }
}

if (!customElements.get("foliate-fxl")) customElements.define("foliate-fxl", FixedLayout);
