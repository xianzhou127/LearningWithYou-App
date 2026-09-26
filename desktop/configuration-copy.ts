import type { ConfigurationError } from "./shared";
export const CONFIGURATION_ERROR_COPY: Record<ConfigurationError, string> = {
  encryption_unavailable: "系统加密不可用，配置未保存。请恢复系统加密后重试。",
  decryption_failed: "原配置无法读取、解密或版本不支持，原文件保留。可重新填写或导入有效配置。",
  invalid_configuration: "配置无效，请核对字段内容。已保存配置保留。",
  invalid_base_url: "地址无效。请使用完整的 HTTP(S) API Base URL，不包含用户名、密码、查询参数或片段。",
  full_endpoint: "请填写 API Base URL，删除末尾 /chat/completions、/completions 或 /responses；程序会追加 /chat/completions。",
  invalid_model: "请填写 1–256 字符的模型标识，不含控制字符。",
  key_binding_required: "分析地址已更改。请重新填写密钥绑定新服务，或选择清除密钥／使用无鉴权服务；原密钥不会发送到新地址。",
  unsupported_asr_provider: "尚未支持该 ASR 厂家，请选择列表中已适配的厂家。原配置保留。",
  missing_asr_key: "请填写所选 ASR 厂家的 API Key。",
  profile_not_found: "该配置已不存在，请重新选择。",
  profile_limit: "每类最多保存 32 条配置，请先删除不再使用的配置。",
  read_failed: "文件无法读取或超过 64 KiB，请选择有效配置文件。",
  save_failed: "加密保存或迁移失败，原文件保留。请检查文件权限与磁盘空间。",
};
