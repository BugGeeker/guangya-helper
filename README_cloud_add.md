# 光鸭云盘 - 磁力链接云添加

在任意网站鼠标悬停磁力链接时显示"云添加"悬浮菜单，解析磁力并一键添加到光鸭云盘。

## 功能

- **自动识别磁力链接**：在任何网站上，当鼠标悬停包含磁力链接（`magnet:` 协议）的 `<a>` 标签时，自动显示悬浮操作按钮。
- **一键云添加**：点击"光鸭"按钮即可解析磁力链接，查看文件列表，选择要添加的文件后一键添加到光鸭云盘的"云添加"功能。
- **文件筛选**：自动默认勾选符合条件的视频文件（mp4/mkv/mov/avi/flv/m4v/ts/wmv/rmvb/mpeg，且大小 >= 10MB）。
- **目录选择**：支持选择保存目录，首次使用会自动查找并默认选中"来自：云添加"文件夹。
- **Token 自动获取与刷新**：访问光鸭云盘页面时自动嗅探并保存 Access Token / Refresh Token；Access Token 失效后会自动刷新并重试原请求。
- **复制磁力链接**：悬浮按钮附带复制功能，方便快速获取磁力链接。

## 安装

1. 安装 [Tampermonkey](https://www.tampermonkey.net/) 或类似油猴扩展
2. 将此 `.user.js` 文件添加到油猴中启用

## 配置

### Token 设置

脚本支持以下 Token 获取方式：

1. **自动嗅探**：访问光鸭云盘（`guangyapan.com`）页面并登录后，脚本会自动捕获并保存 Access Token 和 Refresh Token。
2. **自动刷新**：接口返回 HTTP 401 时，脚本会调用 `/v1/auth/token`，使用 Refresh Token 换取新的 Access Token，然后自动重试原请求。并发请求只会触发一次刷新。
3. **手动设置 Access Token**：通过油猴菜单 `☁ 设置 Authorization Token` 手动输入。
4. **手动设置 Refresh Token**：通过油猴菜单 `🔑 设置 Refresh Token` 输入，适用于自动嗅探不到 Refresh Token 的情况。

### 油猴菜单命令

| 命令 | 说明 |
|------|------|
| `☁ 设置 Authorization Token` | 手动设置/更新 Authorization Token（可包含 "Bearer " 前缀） |
| `🔑 设置 Refresh Token` | 手动设置/更新用于自动刷新的 Refresh Token |
| `🧽 清空手动设置的 Token` | 清除手动设置的 Access Token |
| `🧹 清除自动 Token 和 Refresh Token` | 清除自动保存的 Access/Refresh Token，下次访问光鸭云盘时会重新嗅探 |
| `🔄 重置保存目录` | 重置已保存的目录选择，下次打开时会重新查找"来自：云添加"文件夹 |

## 使用方法

1. 浏览任意包含磁力链接的网站
2. 将鼠标悬停在磁力链接上，会显示悬浮按钮：
   - 🟠 **光鸭图标按钮**：点击解析磁力并打开云添加弹窗
   - 🧲 **复制按钮**：复制磁力链接到剪贴板
3. 在弹窗中：
   - 查看磁力链接解析后的文件信息（文件名、大小、文件数、创建时间）
   - 选择保存目录（点击"添加到"行的目录选择区域）
   - 勾选要添加的文件（视频文件默认已勾选）
   - 点击"立即添加"完成操作

## API 接口

脚本使用以下光鸭云盘 API：

| 接口 | 路径 | 说明 |
|------|------|------|
| 刷新 Token | `POST https://account.guangyapan.com/v1/auth/token` | 使用 Refresh Token 获取新的 Access Token |
| 解析资源 | `POST /cloudcollection/v1/resolve_res` | 解析磁力链接，获取文件列表 |
| 创建任务 | `POST /cloudcollection/v1/create_task` | 创建云添加任务 |
| 文件列表 | `POST /userres/v1/file/get_file_list` | 获取云盘目录列表 |

## 注意事项

- Access Token 失效时会自动使用 Refresh Token 刷新；若 Refresh Token 也已失效，请重新登录光鸭云盘或手动更新 Token
- 保存目录选择后会持久化，如需更改可通过"重置保存目录"命令
- 脚本需要 `GM_xmlhttpRequest`、`GM_setValue`、`GM_getValue`、`GM_deleteValue`、`GM_registerMenuCommand`、`GM_setClipboard`、`GM_openInTab` 等权限，并需要连接 `api.guangyapan.com` 和 `account.guangyapan.com`
