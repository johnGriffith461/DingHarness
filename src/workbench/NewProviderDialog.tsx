import { useState } from "react";

import type { ShellBridge } from "@shared/ipc";
import { formatFromUrl, nameFromUrl } from "@shared/providerForm";
import type { CustomProviderWire, ProviderFormatWire } from "@shared/providerWire";

import { enabledAfterPull, readModelSettings, saveProviderModels } from "./modelSettingsStore";

/**
 * **「添加供应商」小窗**（M-03，2026-10-21 重做）。
 *
 * ## 为什么是这个小窗、这个顺序
 *
 * 主人点名的字段顺序是 **URL → Key → 模型**：接一个没见过的端点时，
 * 用户能自己确定的只有这三件；名字和格式是"高级"里的可改项（能从地址推就推）。
 *
 * 形状照 OpenCode：**先拉后选**，拉回来的清单**默认一个都不勾** ——
 * 那正是主人报的第 3 条（"拉取模型默认全选"）。
 *
 * ## 两个硬约束
 *
 * 1. 弹窗用 `wb-modal-mask` + `wb-modal-card`（**不再用 `wb-setfull` 整页覆盖**）；
 * 2. 密钥 `type=password`，保存后不回显、不回传。
 *
 * ## 保存之后
 *
 * 新供应商的模型清单 = 这次勾的（provider 必须至少有一个模型才可保存），
 * 但**启用清单是空的** —— 与设置页"拉取后默认不勾"同一条语义。
 */

const FORMATS: Array<{ value: ProviderFormatWire; label: string; hint: string }> = [
  { value: "anthropic", label: "Anthropic Messages (/v1/messages)", hint: "Anthropic 官方与兼容它的中转" },
  {
    value: "openai-compatible",
    label: "Chat Completions (/chat/completions)",
    hint: "最常见的 OpenAI 兼容格式（多数中转站）",
  },
  { value: "openai-responses", label: "Responses (/responses)", hint: "OpenAI 的新接口，与 Chat Completions 不同" },
];

type Props = {
  bridge: ShellBridge["providers"];
  /** 编辑已有的自定义供应商（M-01 详情里的「编辑」）。 */
  editing?: CustomProviderWire;
  onDone: (added: boolean, providerId?: string) => void;
};

export function NewProviderDialog({ bridge, editing, onDone }: Props) {
  const [baseURL, setBaseURL] = useState(editing?.baseURL ?? "");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>(editing ? [...editing.models] : []);
  const [picked, setPicked] = useState<string[]>(editing ? [...editing.models] : []);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  /* 高级区：用户改过就以用户为准，没改过就一直跟着 URL 自动推 */
  const [nameDraft, setNameDraft] = useState(editing?.label ?? "");
  const [nameTouched, setNameTouched] = useState(Boolean(editing));
  const [formatDraft, setFormatDraft] = useState<ProviderFormatWire>(editing?.protocol ?? "openai-compatible");
  const [formatTouched, setFormatTouched] = useState(Boolean(editing));

  const autoName = nameFromUrl(baseURL);
  const autoFormat = formatFromUrl(baseURL);
  const label = nameTouched ? nameDraft : autoName;
  const format = formatTouched ? formatDraft : autoFormat;

  const fetchModels = async () => {
    const next: Record<string, string> = {};
    if (!/^https?:\/\//.test(baseURL.trim())) next.baseURL = "要填完整地址（http/https 开头）";
    if (!apiKey.trim()) next.apiKey = "拉取模型需要 API Key";
    setErrors(next);
    if (Object.keys(next).length) return;

    setFetching(true);
    const res = await bridge.fetchModels({ baseURL: baseURL.trim(), apiKey: apiKey.trim() });
    setFetching(false);
    if (!res.ok) {
      setErrors({ fetch: res.error ?? "拉取失败（对方没有给原因）" });
      return;
    }
    const list = res.models ?? [];
    setModels(list);
    /* ⭐ 默认一个都不勾（主人报的第 3 条） */
    setPicked([]);
    if (!list.length) setErrors({ fetch: "对方返回的模型清单是空的" });
  };

  const save = async () => {
    const next: Record<string, string> = {};
    if (!/^https?:\/\//.test(baseURL.trim())) next.baseURL = "要填完整地址（http/https 开头）";
    /* 编辑态：留空 = 不改密钥（密钥本来就不回显） */
    if (!editing && !apiKey.trim()) next.apiKey = "API Key 不能为空";
    if (!models.length) next.models = "先「拉取模型」，再勾要用的";
    if (!picked.length) next.models = "至少勾一个模型（这个供应商需要至少一个可用的模型名）";
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    const payload = {
      label: label.trim() || "我的中转站",
      baseURL: baseURL.trim(),
      format,
      models: picked,
      ...(apiKey.trim() ? { apiKey: apiKey.trim() } : {}),
    };
    const res = editing ? await bridge.update(editing.id, payload) : await bridge.add(payload);
    setSaving(false);
    if (!res.ok) {
      setErrors({ form: res.error });
      return;
    }
    if (editing) {
      /*
       * 编辑：模型清单可能变了 —— 启用清单保留交集（下架的模型自然消失），
       * 与「同步模型」同一条语义。
       */
      const previous = readModelSettings()[editing.id];
      saveProviderModels(editing.id, {
        models: [...res.provider.models],
        enabled: enabledAfterPull(previous, res.provider.models),
        ...(previous?.default && res.provider.models.includes(previous.default) ? { default: previous.default } : {}),
      });
    } else {
      /*
       * 新供应商的模型**全部未启用**（M-03 的判据）：勾选在这里只表示
       * "这个端点有这些模型"，启用与否由设置页的模型清单决定。
       */
      saveProviderModels(res.provider.id, { models: [...res.provider.models], enabled: [] });
    }
    onDone(true, res.provider.id);
  };

  return (
    <div className="wb-modal-mask" data-testid="wb-newprovider-mask">
      <div
        className="wb-modal wb-modal-card wb-mset-dialog"
        data-testid="wb-newprovider-dialog"
        role="dialog"
        aria-modal="true"
        aria-label="添加供应商"
      >
        <div className="wb-modal-head">
          <strong>{editing ? "编辑供应商" : "添加供应商"}</strong>
        </div>

        <div className="wb-mset-field">
          <label htmlFor="wb-newprovider-baseurl-input">接口地址 *</label>
          <input
            id="wb-newprovider-baseurl-input"
            className="wb-card-input"
            data-testid="wb-newprovider-baseurl"
            value={baseURL}
            onChange={(event) => {
              setBaseURL(event.target.value);
              /* 地址变了，之前拉的清单不再作数（避免拿 A 家的模型存到 B 家） */
              setModels([]);
              setPicked([]);
            }}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
          />
          {errors.baseURL ? <div className="wb-card-note wb-note-bad">{errors.baseURL}</div> : null}
        </div>

        <div className="wb-mset-field">
          <label htmlFor="wb-newprovider-key-input">API Key {editing ? "" : "*"}</label>
          <input
            id="wb-newprovider-key-input"
            className="wb-card-input"
            data-testid="wb-newprovider-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={editing ? "留空 = 不改密钥" : "sk-…"}
            spellCheck={false}
            autoComplete="off"
          />
          {errors.apiKey ? <div className="wb-card-note wb-note-bad">{errors.apiKey}</div> : null}
        </div>

        <div className="wb-mset-field">
          <div className="wb-mset-rowline">
            <label>模型 *</label>
            <button
              className="wb-page-btn"
              data-testid="wb-newprovider-fetch"
              disabled={fetching}
              onClick={() => void fetchModels()}
            >
              {fetching ? "拉取中…" : "拉取模型"}
            </button>
          </div>
          {errors.fetch ? <div className="wb-card-note wb-note-bad">{errors.fetch}</div> : null}
          {errors.models ? <div className="wb-card-note wb-note-bad">{errors.models}</div> : null}
          {models.length === 0 ? (
            <div className="wb-card-note" data-testid="wb-newprovider-empty">
              先填地址与 Key，点「拉取模型」——名字由对方给，不由我们猜。
            </div>
          ) : (
            <div className="wb-modelset-models" data-testid="wb-newprovider-models">
              {models.map((model) => {
                const on = picked.includes(model);
                return (
                  <div className="wb-modelset-model" key={model}>
                    <button
                      className={`wb-modelset-check${on ? " is-on" : ""}`}
                      data-testid={`wb-newprovider-pick-${model}`}
                      aria-label={`${on ? "不选" : "选"} ${model}`}
                      onClick={() => setPicked(on ? picked.filter((m) => m !== model) : [...picked, model])}
                    >
                      {on ? "✓" : ""}
                    </button>
                    <span className="wb-modelset-modelname">{model}</span>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <details className="wb-mset-adv" data-testid="wb-newprovider-advanced">
          <summary>高级</summary>
          <div className="wb-mset-field">
            <label htmlFor="wb-newprovider-label-input">名称</label>
            <input
              id="wb-newprovider-label-input"
              className="wb-card-input"
              data-testid="wb-newprovider-label"
              value={label}
              onChange={(event) => {
                setNameTouched(true);
                setNameDraft(event.target.value);
              }}
              placeholder="api.example.com"
            />
            <div className="wb-card-note">默认取地址里的主机名，可改。</div>
          </div>
          <div className="wb-mset-field">
            <label htmlFor="wb-newprovider-format-input">格式</label>
            <select
              id="wb-newprovider-format-input"
              className="wb-card-input"
              data-testid="wb-newprovider-format"
              value={format}
              onChange={(event) => {
                setFormatTouched(true);
                setFormatDraft(event.target.value as ProviderFormatWire);
              }}
            >
              {FORMATS.map((item) => (
                <option key={item.value} value={item.value}>
                  {item.label}
                </option>
              ))}
            </select>
            <div className="wb-card-note">
              {FORMATS.find((f) => f.value === format)?.hint}；选错的表现是 404 或字段不认识。
            </div>
          </div>
        </details>

        {errors.form ? <div className="wb-card-note wb-note-bad">{errors.form}</div> : null}

        <div className="wb-modal-foot">
          <button className="wb-page-btn" data-testid="wb-newprovider-cancel" onClick={() => onDone(false)}>
            取消
          </button>
          <button
            className="wb-page-btn wb-page-btn-primary"
            data-testid="wb-newprovider-save"
            disabled={saving}
            onClick={() => void save()}
          >
            {saving ? "保存中…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
