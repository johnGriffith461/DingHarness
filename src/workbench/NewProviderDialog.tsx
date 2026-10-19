import { useState } from "react";

import type { ShellBridge } from "@shared/ipc";
import type { ProviderFormatWire } from "@shared/providerWire";

/**
 * **「新供应商」表单**（T0）。
 *
 * ## 表单长什么样、为什么是这三项
 *
 * 用户接一个没见过的端点时，能自己确定的只有三件事：
 * **地址**、**它说哪种格式**、**密钥**。剩下的（有哪些模型）不该靠猜 ——
 * 点「拉取模型」问对方，名字由对方给。
 *
 * 三种格式的区别是**线路**，不是厂商：
 * - `/v1/messages` → Anthropic 原生；
 * - `/chat/completions` → OpenAI 兼容（绝大多数中转站）；
 * - `/responses` → OpenAI Responses API（新接口，与上一条不是一回事）。
 *
 * 选错的表现是 404 或"字段不认识"，所以这里让用户明确选，不替他推断。
 *
 * ## 密钥
 *
 * 输入框 `type=password`，保存后**不回显、不回传**：主进程收到直接写凭据库。
 * 表单里也不做"显示明文"的开关 —— 这个页面上没有需要用户核对密钥的场景。
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
  onDone: (added: boolean) => void;
};

export function NewProviderDialog({ bridge, onDone }: Props) {
  const [label, setLabel] = useState("");
  const [baseURL, setBaseURL] = useState("");
  const [format, setFormat] = useState<ProviderFormatWire>("openai-compatible");
  const [apiKey, setApiKey] = useState("");
  const [models, setModels] = useState<string[]>([]);
  const [picked, setPicked] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [saving, setSaving] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});

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
    /* 一个模型都没给时**不假装成功** */
    if (!list.length) setErrors({ fetch: "对方返回的模型清单是空的" });
    else setPicked(list.slice(0, 1));
  };

  const save = async () => {
    const next: Record<string, string> = {};
    if (!label.trim()) next.label = "给它起个名字（你以后在 provider 列表里看到的就是它）";
    if (!models.length) next.models = "先「拉取模型」，再勾要用的";
    if (!picked.length) next.models = "至少勾一个模型";
    setErrors(next);
    if (Object.keys(next).length) return;

    setSaving(true);
    const res = await bridge.add({
      label: label.trim(),
      baseURL: baseURL.trim(),
      format,
      apiKey: apiKey.trim(),
      models: picked,
    });
    setSaving(false);
    if (!res.ok) {
      setErrors({ form: res.error });
      return;
    }
    onDone(true);
  };

  return (
    <div className="wb-setfull" data-testid="wb-newprovider-dialog" role="dialog" aria-label="新供应商">
      <div className="wb-setfull-head">
        <strong>新供应商</strong>
      </div>

      <div className="wb-card">
        <div className="wb-card-row">
          <span className="wb-card-label">名字</span>
          <span className="wb-card-desc">你认得出来的叫法；内部 id 由它自动生成</span>
          <input
            className="wb-card-input"
            data-testid="wb-newprovider-label"
            value={label}
            onChange={(event) => setLabel(event.target.value)}
            placeholder="我的中转站"
          />
        </div>
        {errors.label ? <div className="wb-card-note wb-note-bad">{errors.label}</div> : null}

        <div className="wb-card-row">
          <span className="wb-card-label">Base URL</span>
          <span className="wb-card-desc">不带末尾斜杠也行；模型清单从它下面的 /models 拉</span>
          <input
            className="wb-card-input"
            data-testid="wb-newprovider-baseurl"
            value={baseURL}
            onChange={(event) => setBaseURL(event.target.value)}
            placeholder="https://api.example.com/v1"
            spellCheck={false}
          />
        </div>
        {errors.baseURL ? <div className="wb-card-note wb-note-bad">{errors.baseURL}</div> : null}

        <div className="wb-card-row">
          <span className="wb-card-label">API 格式</span>
          <span className="wb-card-desc">选错的表现是 404 或字段不认识，所以这里不替你推断</span>
          <select
            className="wb-card-input"
            data-testid="wb-newprovider-format"
            value={format}
            onChange={(event) => setFormat(event.target.value as ProviderFormatWire)}
          >
            {FORMATS.map((item) => (
              <option key={item.value} value={item.value}>
                {item.label}
              </option>
            ))}
          </select>
        </div>
        <div className="wb-card-note">{FORMATS.find((f) => f.value === format)?.hint}</div>

        <div className="wb-card-row">
          <span className="wb-card-label">API Key</span>
          <span className="wb-card-desc">保存后写进本机凭据库，不回显、不回传</span>
          <input
            className="wb-card-input"
            data-testid="wb-newprovider-key"
            type="password"
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder="sk-…"
            spellCheck={false}
          />
        </div>
        {errors.apiKey ? <div className="wb-card-note wb-note-bad">{errors.apiKey}</div> : null}
      </div>

      <div className="wb-card">
        <div className="wb-card-row">
          <span className="wb-card-label">模型列表</span>
          <span className="wb-card-desc">名字由对方给，不由我们猜</span>
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
            当前没有配置模型，拉取后勾选，才能在聊天里用。
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
                    onClick={() =>
                      setPicked(on ? picked.filter((m) => m !== model) : [...picked, model])
                    }
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

      {errors.form ? <div className="wb-card-note wb-note-bad">{errors.form}</div> : null}

      <div className="wb-setfull-foot">
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
  );
}
