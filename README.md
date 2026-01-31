# 期权分析 Web 应用

## 运行方式

1. 安装后端依赖：

```bash
cd server
npm install
```

2. 启动服务：

```bash
npm start
```

默认访问 `http://localhost:3000`。

> 建议使用 Node.js 18+（内置 `fetch`）。
## 配置说明

- 富途期权链 API 基地址：`FUTU_API_BASE`，默认 `http://localhost:8081`

示例：

```bash
FUTU_API_BASE=http://localhost:8081 npm start
```

## 项目结构

- `server/index.js`：Express 代理服务
- `client/index.html`：静态页面入口
- `client/app.js`：Vue + Element Plus 前端逻辑
- `client/styles.css`：页面样式

## 说明

- 前端依赖（Vue、Element Plus、math.js、ECharts）通过 CDN 加载。
- 若需要离线使用，可替换为本地打包方案（如 Vite）。
