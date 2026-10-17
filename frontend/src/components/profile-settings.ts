import { LitElement, type PropertyValues, css, html, nothing } from "lit";
import { mdiClose, mdiPlus } from "@mdi/js";
import type { FileUpload, SettingDef, Settings } from "../api";
import { inputValue, isDefined } from "../ha";
import {
  categoryLabel,
  categoryRank,
  parseText,
  pickUpload,
  rangeText,
  renderSettingControl,
  settingRowStyles,
} from "../setting-controls";
import { sharedStyles } from "../styles";
import { define, formatValue } from "../ui";
import { conditionHolds, describeCondition } from "../visibility";

export interface ProfileSettingsChange {
  settings: Settings;
  /** Keys whose input does not parse; their last valid value stays in `settings`. */
  invalid: string[];
}

export interface FilePicked {
  key: string;
  file: FileUpload;
}

/** Value a newly added setting starts with. */
const initialValue = (def: SettingDef): unknown => {
  if (def.default !== undefined && def.default !== null) return def.default;
  switch (def.type) {
    case "bool":
      return false;
    case "int":
    case "float":
      return def.min ?? 0;
    case "enum":
      return def.options?.[0]?.value ?? "";
    case "string_list":
      return [];
    default:
      return "";
  }
};

/** Definition for a key the schema does not know, from its value. */
const guessDef = (key: string, value: unknown): SettingDef => {
  let type = "string";
  if (typeof value === "boolean") type = "bool";
  else if (typeof value === "number") type = Number.isInteger(value) ? "int" : "float";
  else if (Array.isArray(value)) type = "string_list";
  return { key, type, label: key, category: "other" };
};

/** Focus the native input inside a ha input element. */
const focusInput = (el: Element | null): void => {
  let node = el;
  for (let depth = 0; depth < 4 && node?.shadowRoot; depth++) {
    const inner = node.shadowRoot.querySelector("input, wa-input, ha-input, ha-textfield");
    if (!inner) break;
    node = inner;
  }
  (node as HTMLElement | null)?.focus();
};

const matches = (def: SettingDef, words: string[]): boolean => {
  const text = [def.key, def.label, def.description, categoryLabel(def.category || "general")]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return words.every((w) => text.includes(w));
};

/**
 * Visual editor of the settings of a profile: one row per setting with its control, and a searchable
 * list of every other setting to add. Fires `settings-changed` ({@link ProfileSettingsChange}) and
 * `file-picked` ({@link FilePicked}) when a file setting gets a file.
 */
export class SeProfileSettings extends LitElement {
  static properties = {
    schema: { attribute: false },
    perDevice: { attribute: false },
    secret: { attribute: false },
    settings: { attribute: false },
    files: { attribute: false },
    _text: { state: true },
    _invalid: { state: true },
    _adding: { state: true },
    _filter: { state: true },
  };

  declare schema: SettingDef[];
  declare perDevice: Set<string>;
  declare secret: Set<string>;
  declare settings: Settings;
  /** Key -> name of the file a file setting has (stored or picked). */
  declare files: Record<string, string>;
  declare _text: Record<string, string>;
  declare _invalid: Set<string>;
  declare _adding: boolean;
  declare _filter: string;

  constructor() {
    super();
    this.schema = [];
    this.perDevice = new Set();
    this.secret = new Set();
    this.settings = {};
    this.files = {};
    this._text = {};
    this._invalid = new Set();
    this._adding = false;
    this._filter = "";
  }

  private get _defs(): Map<string, SettingDef> {
    return new Map(this.schema.map((d) => [d.key, d]));
  }

  private _def(key: string): SettingDef {
    return this._defs.get(key) ?? guessDef(key, this.settings[key]);
  }

  private _emit(settings: Settings, invalid = this._invalid): void {
    this.dispatchEvent(
      new CustomEvent<ProfileSettingsChange>("settings-changed", { detail: { settings, invalid: [...invalid] } }),
    );
  }

  private _setValue(key: string, value: unknown): void {
    this._emit({ ...this.settings, [key]: value });
  }

  private _setText(def: SettingDef, text: string): void {
    this._text = { ...this._text, [def.key]: text };
    const [ok, value] = parseText(def, text);
    const invalid = new Set(this._invalid);
    if (ok) invalid.delete(def.key);
    else invalid.add(def.key);
    this._invalid = invalid;
    this._emit(ok ? { ...this.settings, [def.key]: value } : this.settings, invalid);
  }

  private _remove(key: string): void {
    const { [key]: _removed, ...rest } = this.settings;
    const { [key]: _text, ...text } = this._text;
    this._text = text;
    const invalid = new Set(this._invalid);
    invalid.delete(key);
    this._invalid = invalid;
    this._emit(rest, invalid);
  }

  private async _pickFile(def: SettingDef): Promise<boolean> {
    const file = await pickUpload(this, def);
    if (!file) return false;
    this.dispatchEvent(new CustomEvent<FilePicked>("file-picked", { detail: { key: def.key, file } }));
    this._setValue(def.key, file.name);
    return true;
  }

  private async _add(def: SettingDef): Promise<void> {
    // a file setting is only worth adding with its file
    if (def.accept) {
      if (await this._pickFile(def)) this._closePicker();
      return;
    }
    this._setValue(def.key, initialValue(def));
    this._closePicker();
  }

  private _openPicker(): void {
    this._filter = "";
    this._adding = true;
  }

  private _closePicker(): void {
    this._adding = false;
  }

  /** Settings that can still be added, in category order. */
  private get _candidates(): SettingDef[] {
    const words = this._filter.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return this.schema
      .map((def, index) => ({ def, index }))
      .filter(
        ({ def }) =>
          !def.hidden &&
          !def.per_device &&
          !this.perDevice.has(def.key) &&
          !(def.key in this.settings) &&
          matches(def, words),
      )
      .sort(
        (a, b) =>
          categoryRank(a.def.category || "general") - categoryRank(b.def.category || "general") || a.index - b.index,
      )
      .map(({ def }) => def);
  }

  /** Forget text being typed, for settings that were replaced from outside. */
  reset(): void {
    this._text = {};
    this._invalid = new Set();
    this._adding = false;
  }

  protected updated(changed: PropertyValues<this>): void {
    if (changed.has("_adding") && this._adding) this._focusSearch();
  }

  /**
   * Typing must reach the search field: anywhere else the keys run the global shortcuts of HA. The
   * field renders its input a moment later and focus can get lost while the dialog settles, so try a
   * few times until it holds.
   */
  private async _focusSearch(): Promise<void> {
    for (const delay of [0, 50, 150, 300]) {
      await new Promise((resolve) => setTimeout(resolve, delay));
      const search = this.renderRoot.querySelector(".picker-search");
      if (!this._adding || !search) return;
      if (search.matches(":focus-within")) break;
      focusInput(search);
    }
    // on a phone the picker opens below the fold
    this.renderRoot.querySelector(".picker")?.scrollIntoView({ block: "start" });
  }

  // ------------------------------------------------------------------ rendering

  /** Conditions of the app that the profile does not meet itself ("Used when Thinking sound is on"). */
  private _usedWhen(def: SettingDef): string {
    const failed = (def.visible_if ?? []).filter(
      (cond) => !(cond.key in this.settings) || !conditionHolds(cond, this.settings[cond.key]),
    );
    if (!failed.length) return "";
    return `Used when ${failed.map((cond) => describeCondition({ cond, parent: this._defs.get(cond.key) })).join(" and ")}`;
  }

  private _renderControl(def: SettingDef) {
    const value = this.settings[def.key];
    if (def.accept) {
      const name = this.files[def.key];
      return html`<span class="file-name">${name || "No file"}</span>
        <ha-button appearance="plain" size="s" @click=${() => this._pickFile(def)}
          >${name ? "Replace…" : "Upload…"}</ha-button
        >`;
    }
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      return html`<span class="file-name" title=${formatValue(value)}>${formatValue(value)}</span>`;
    }
    return renderSettingControl(def, {
      value,
      text: this._text[def.key],
      invalid: this._invalid.has(def.key),
      secret: def.secret || this.secret.has(def.key),
      onValue: (v) => this._setValue(def.key, v),
      onText: (t) => this._setText(def, t),
    });
  }

  private _renderRow(def: SettingDef) {
    const range = rangeText(def);
    const notes = [def.key, range].filter(Boolean).join(" · ");
    const usedWhen = this._usedWhen(def);
    const noFile = def.accept && !this.files[def.key];
    const isObject = this.settings[def.key] !== null && typeof this.settings[def.key] === "object" && !Array.isArray(this.settings[def.key]);
    return html`
      <ha-list-item-base>
        <span slot="headline">${def.label || def.key}</span>
        <span slot="supporting-text"
          >${def.description ? html`${def.description}<br />` : nothing}${notes}${usedWhen
            ? html`<br /><span class="lock">${usedWhen}</span>`
            : nothing}${noFile
            ? html`<br /><span class="error">Upload the file, a name alone is not sent to the displays</span>`
            : nothing}${isObject ? html`<br /><span class="lock">Edit this value in JSON</span>` : nothing}${this._invalid.has(
            def.key,
          )
            ? html`<br /><span class="error">Invalid value${range ? ` (${range})` : ""}</span>`
            : nothing}</span
        >
        <div slot="end" class="end">
          ${this._renderControl(def)}
          <ha-icon-button
            class="remove"
            .label=${`Remove ${def.label || def.key}`}
            .path=${mdiClose}
            @click=${() => this._remove(def.key)}
          ></ha-icon-button>
        </div>
      </ha-list-item-base>
    `;
  }

  private _renderRows() {
    const keys = Object.keys(this.settings);
    if (!keys.length) {
      return html`<div class="empty secondary">No settings yet. Add the ones this profile should set.</div>`;
    }
    const order = new Map(this.schema.map((d, i) => [d.key, i]));
    const groups = new Map<string, SettingDef[]>();
    for (const def of keys.map((k) => this._def(k))) {
      const cat = def.category || "general";
      groups.set(cat, [...(groups.get(cat) ?? []), def]);
    }
    const cats = [...groups.keys()].sort((a, b) => categoryRank(a) - categoryRank(b) || a.localeCompare(b));
    return cats.map((cat) => {
      const defs = (groups.get(cat) ?? []).sort(
        (a, b) => (order.get(a.key) ?? 1e6) - (order.get(b.key) ?? 1e6) || a.key.localeCompare(b.key),
      );
      return html`
        <div class="group">${cat === "other" ? "Not described by the displays" : categoryLabel(cat)}</div>
        <ha-list-base class="rows" aria-label=${categoryLabel(cat)}>${defs.map((d) => this._renderRow(d))}</ha-list-base>
      `;
    });
  }

  private _renderPicker() {
    const candidates = this._candidates;
    const onInput = (e: Event) => (this._filter = inputValue(e));
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        // closes the picker, not the dialog around it
        e.preventDefault();
        e.stopPropagation();
        this._closePicker();
      } else if (e.key === "Enter" && candidates.length) {
        e.preventDefault();
        this._add(candidates[0]);
      }
    };
    const groups = new Map<string, SettingDef[]>();
    for (const def of candidates) {
      const cat = def.category || "general";
      groups.set(cat, [...(groups.get(cat) ?? []), def]);
    }
    return html`
      <div class="picker">
        <div class="picker-top">
          ${isDefined("ha-input-search")
            ? html`<ha-input-search
                class="picker-search"
                appearance="outlined"
                .placeholder=${"Search settings"}
                .value=${this._filter}
                @input=${onInput}
                @keydown=${onKey}
              ></ha-input-search>`
            : html`<ha-input
                class="picker-search"
                .placeholder=${"Search settings"}
                .value=${this._filter}
                @input=${onInput}
                @keydown=${onKey}
              ></ha-input>`}
          <ha-button appearance="plain" @click=${this._closePicker}>Done</ha-button>
        </div>
        <div class="candidates">
          ${[...groups.entries()].map(
            ([cat, defs]) => html`
              <div class="group">${categoryLabel(cat)}</div>
              <ha-list-base aria-label=${categoryLabel(cat)}>
                ${defs.map(
                  (def) => html`
                    <ha-list-item-button @click=${() => this._add(def)}>
                      <ha-svg-icon slot="start" .path=${mdiPlus}></ha-svg-icon>
                      <span slot="headline">${def.label || def.key}</span>
                      <span slot="supporting-text">${def.description ? `${def.description} · ` : ""}${def.key}</span>
                    </ha-list-item-button>
                  `,
                )}
              </ha-list-base>
            `,
          )}
          ${candidates.length
            ? nothing
            : html`<div class="empty secondary">
                ${this._filter.trim() ? `No settings match “${this._filter.trim()}”.` : "Every setting is in the profile."}
              </div>`}
        </div>
      </div>
    `;
  }

  render() {
    return html`
      ${this._renderRows()}
      ${this._adding
        ? this._renderPicker()
        : html`<ha-button class="add" appearance="plain" @click=${this._openPicker}>
            <ha-svg-icon slot="start" .path=${mdiPlus}></ha-svg-icon>Add setting
          </ha-button>`}
    `;
  }

  static styles = [
    sharedStyles,
    settingRowStyles,
    css`
      :host {
        display: block;
      }
      .group {
        margin: var(--ha-space-3) 0 var(--ha-space-1);
        font-size: var(--ha-font-size-s);
        font-weight: var(--ha-font-weight-medium);
        color: var(--secondary-text-color);
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }
      .group:first-child {
        margin-top: 0;
      }
      .end {
        gap: var(--ha-space-1);
      }
      .remove {
        color: var(--secondary-text-color);
      }
      .lock {
        font-style: italic;
      }
      .empty {
        padding: var(--ha-space-4) 0;
      }
      .add {
        margin-top: var(--ha-space-2);
      }
      .picker {
        margin-top: var(--ha-space-3);
        border: 1px solid var(--divider-color);
        border-radius: var(--ha-card-border-radius, 12px);
        padding: var(--ha-space-3);
      }
      .picker-top {
        display: flex;
        align-items: center;
        gap: var(--ha-space-2);
      }
      .picker-search {
        flex: 1;
        min-width: 0;
      }
      .candidates {
        max-height: 40vh;
        overflow-y: auto;
        margin-top: var(--ha-space-2);
      }
    `,
  ];
}

define("sep-profile-settings", SeProfileSettings);

declare global {
  interface HTMLElementTagNameMap {
    "sep-profile-settings": SeProfileSettings;
  }
}
