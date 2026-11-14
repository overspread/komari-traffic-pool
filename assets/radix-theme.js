(function () {
  const themeAttributes = [
    "data-accent-color",
    "data-gray-color",
    "data-has-background",
    "data-panel-background",
    "data-radius",
    "data-scaling",
  ];
  const syncedVariables = new Set();
  let controlsObserver = null;
  let themeObserver = null;
  let controlsFrame = 0;
  let themeFrame = 0;

  console.info("[radix-theme] bridge loaded", document.currentScript?.src || "inline");

  function setSelectOpen(control, open) {
    control.dataset.open = String(open);
    control.querySelector("[data-radix-select-trigger]")?.setAttribute("aria-expanded", String(open));
    const menu = control.querySelector(".radix-select-menu");
    if (menu) menu.hidden = !open;
  }

  function closeSelects(except = null) {
    document.querySelectorAll("[data-radix-select-control][data-open='true']").forEach((control) => {
      if (control !== except) setSelectOpen(control, false);
    });
  }

  function optionSignature(select) {
    return JSON.stringify({
      disabled: select.disabled,
      selectedIndex: select.selectedIndex,
      options: Array.from(select.options, (option) => [
        option.value,
        option.textContent,
        option.disabled,
      ]),
    });
  }

  function syncSelect(control) {
    const select = control.querySelector("select");
    const trigger = control.querySelector("[data-radix-select-trigger]");
    const menu = control.querySelector(".radix-select-menu");
    if (!select || !trigger || !menu) return;

    const signature = optionSignature(select);
    if (control.dataset.optionsSignature === signature) return;
    control.dataset.optionsSignature = signature;

    const selectedOption = select.options[select.selectedIndex] || select.options[0];
    trigger.disabled = select.disabled;
    trigger.querySelector(".radix-select-value").textContent = selectedOption?.textContent?.trim() || "";
    menu.replaceChildren();

    Array.from(select.options).forEach((option, index) => {
      const item = document.createElement("button");
      item.className = "radix-select-option";
      item.type = "button";
      item.role = "option";
      item.textContent = option.textContent;
      item.disabled = option.disabled;
      item.dataset.index = String(index);
      item.setAttribute("aria-selected", String(index === select.selectedIndex));
      menu.appendChild(item);
    });
  }

  function focusAdjacentOption(menu, direction) {
    const options = Array.from(menu.querySelectorAll(".radix-select-option:not(:disabled)"));
    if (!options.length) return;
    const currentIndex = options.indexOf(document.activeElement);
    const nextIndex = currentIndex < 0
      ? 0
      : (currentIndex + direction + options.length) % options.length;
    options[nextIndex].focus();
  }

  function enhanceSelect(select) {
    if (select.dataset.radixSelectEnhanced === "true") {
      syncSelect(select.closest("[data-radix-select-control]"));
      return false;
    }

    select.dataset.radixSelectEnhanced = "true";
    select.tabIndex = -1;

    const control = document.createElement("div");
    control.className = "radix-select-control";
    control.dataset.radixSelectControl = "true";
    control.dataset.open = "false";

    const trigger = document.createElement("button");
    trigger.className = "radix-select-trigger";
    trigger.type = "button";
    trigger.dataset.radixSelectTrigger = "true";
    trigger.setAttribute("aria-haspopup", "listbox");
    trigger.setAttribute("aria-expanded", "false");

    const value = document.createElement("span");
    value.className = "radix-select-value";
    const arrow = document.createElement("span");
    arrow.className = "radix-select-arrow";
    arrow.setAttribute("aria-hidden", "true");
    trigger.append(value, arrow);

    const menu = document.createElement("div");
    menu.className = "radix-select-menu";
    menu.id = `${select.id || "radix-select"}-menu`;
    menu.role = "listbox";
    menu.hidden = true;
    trigger.setAttribute("aria-controls", menu.id);

    select.before(control);
    control.append(trigger, menu, select);
    select.classList.add("radix-select-native");

    trigger.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const open = control.dataset.open !== "true";
      closeSelects(control);
      setSelectOpen(control, open);
      if (open) {
        const selected = menu.querySelector("[aria-selected='true']:not(:disabled)")
          || menu.querySelector(".radix-select-option:not(:disabled)");
        selected?.focus();
      }
    });

    trigger.addEventListener("keydown", (event) => {
      if (!["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) return;
      event.preventDefault();
      setSelectOpen(control, true);
      const selected = menu.querySelector("[aria-selected='true']:not(:disabled)")
        || menu.querySelector(".radix-select-option:not(:disabled)");
      selected?.focus();
    });

    menu.addEventListener("click", (event) => {
      const item = event.target.closest(".radix-select-option");
      if (!item || item.disabled) return;
      event.stopPropagation();
      select.selectedIndex = Number(item.dataset.index);
      select.dispatchEvent(new Event("change", { bubbles: true }));
      setSelectOpen(control, false);
      if (document.contains(trigger)) trigger.focus();
    });

    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setSelectOpen(control, false);
        trigger.focus();
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        focusAdjacentOption(menu, 1);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        focusAdjacentOption(menu, -1);
      } else if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const options = menu.querySelectorAll(".radix-select-option:not(:disabled)");
        options[event.key === "Home" ? 0 : options.length - 1]?.focus();
      } else if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        document.activeElement?.click();
      }
    });

    select.addEventListener("change", () => {
      control.dataset.optionsSignature = "";
      syncSelect(control);
    });
    syncSelect(control);
    return true;
  }

  function enhanceSelects() {
    controlsFrame = 0;
    let enhanced = 0;
    document.querySelectorAll("select").forEach((select) => {
      if (enhanceSelect(select)) enhanced += 1;
    });
    if (enhanced) console.info("[radix-theme] selects enhanced", enhanced);
  }

  function scheduleSelectEnhancement() {
    if (controlsFrame) return;
    controlsFrame = requestAnimationFrame(enhanceSelects);
  }

  function installRadixControls() {
    if (controlsObserver) return;
    document.addEventListener("click", (event) => {
      if (!event.target.closest?.("[data-radix-select-control]")) closeSelects();
    });
    controlsObserver = new MutationObserver(scheduleSelectEnhancement);
    controlsObserver.observe(document.body, { childList: true, subtree: true });
    enhanceSelects();
    console.info("[radix-theme] control enhancer ready");
  }

  function findParentTheme(parentDocument) {
    return parentDocument.querySelector(
      ".theme-root.radix-themes, .radix-themes[data-is-root-theme='true'], .radix-themes",
    ) || parentDocument.documentElement;
  }

  function copyThemeVariables(source, target) {
    const styles = source.ownerDocument.defaultView.getComputedStyle(source);
    const nextVariables = new Set();

    for (let index = 0; index < styles.length; index += 1) {
      const name = styles[index];
      if (!name.startsWith("--")) continue;
      const value = styles.getPropertyValue(name).trim();
      if (!value) continue;
      target.style.setProperty(name, value);
      nextVariables.add(name);
    }

    syncedVariables.forEach((name) => {
      if (!nextVariables.has(name)) target.style.removeProperty(name);
    });
    syncedVariables.clear();
    nextVariables.forEach((name) => syncedVariables.add(name));
    return nextVariables.size;
  }

  function syncParentTheme() {
    themeFrame = 0;
    const parentDocument = window.parent.document;
    const parentRoot = parentDocument.documentElement;
    const parentTheme = findParentTheme(parentDocument);
    const target = document.documentElement;
    const dark = parentRoot.classList.contains("dark")
      || parentTheme.classList.contains("dark")
      || parentTheme.classList.contains("dark-theme");

    target.classList.add("radix-themes");
    target.classList.toggle("dark", dark);
    target.classList.toggle("dark-theme", dark);
    target.classList.toggle("light", !dark);
    target.classList.toggle("light-theme", !dark);
    target.setAttribute("data-is-root-theme", "true");
    target.style.colorScheme = dark ? "dark" : "light";
    target.lang = parentRoot.lang || "zh-CN";

    themeAttributes.forEach((attribute) => {
      const value = parentTheme.getAttribute(attribute);
      if (value === null) target.removeAttribute(attribute);
      else target.setAttribute(attribute, value);
    });

    const variableCount = copyThemeVariables(parentTheme, target);
    document.dispatchEvent(new CustomEvent("radix-theme-change", {
      detail: { language: target.lang, appearance: dark ? "dark" : "light" },
    }));
    console.info("[radix-theme] parent theme synced", {
      appearance: dark ? "dark" : "light",
      accent: target.getAttribute("data-accent-color"),
      variables: variableCount,
    });
  }

  function scheduleThemeSync() {
    if (themeFrame) return;
    themeFrame = requestAnimationFrame(syncParentTheme);
  }

  function installRadixTheme() {
    if (themeObserver) return;
    installRadixControls();
    const parentRoot = window.parent.document.documentElement;
    themeObserver = new MutationObserver(scheduleThemeSync);
    themeObserver.observe(parentRoot, {
      attributes: true,
      childList: true,
      subtree: true,
      attributeFilter: ["class", "style", "lang", ...themeAttributes],
    });
    syncParentTheme();
  }

  window.installRadixTheme = installRadixTheme;
  window.installRadixControls = installRadixControls;

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", installRadixTheme, { once: true });
  } else {
    installRadixTheme();
  }
})();
