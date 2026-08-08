# JavaScript 前端工程实践

前端工程化是现代 Web 开发的基础，核心包括模块打包、构建优化与代码规范。常用的打包工具有 Webpack、Vite，Vite 基于原生 ESM，开发冷启动速度非常快。

Tag: 前端, JavaScript, 工程化, 构建

组件化设计原则是把界面拆成可复用的独立单元，配合状态管理库的受控模式管理全局数据。React 的组件生命周期和 Hooks 用法是面试高频题：useState、useEffect、useMemo 的使用边界要分清楚。

构建性能优化可以从三方面入手：代码分割（Code Splitting）、Tree Shaking 去除无用代码、按需加载第三方库。浏览器缓存策略上，文件名加内容哈希可以长期缓存不变资源。

工程规范方面，ESLint 与 Prettier 搭配保证代码风格一致，Commit 信息遵循 Conventional Commits 规范，配合 CI 流水线做自动检查与部署。

最后记录一个常见坑：跨域问题。开发环境下代理转发到后端接口解决 CORS，生产环境则用 Nginx 反向代理统一访问入口。