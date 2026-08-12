# Propagation Support Rerank

## 目标

Propagation Support Rerank 用候选 chunk 的 tag/support 信号，对基础候选做确定性重排。它不是外部模型调用。

## 输入与输出

输入：

- merged/expanded candidates；
- 查询 tag basis/residual 和传播输出；
- candidate 的 tags、向量或 support 数据；
- \`propagationSupportRerankEnabled\` 及相关 support 权重/阈值。

输出：

- 按 support 组合分数排序的候选；
- \`propagationSupport\` 诊断；
- 失败/跳过时的显式状态字段。

## 阶段

它位于 tag expansion、embedding rerank 等候选生产/局部算法之后，relation expansion 之前或附近，最终仍会进入 dedupe 和 common postprocess tail。准确执行情况应以 \`retrievalTrace.stageOrder\` 为准。

## 计算语义

实现将候选与传播结果的支持程度结合，通常同时考虑：

- 候选原始/语义分数；
- tag activation/coverage；
- propagation support；
- 可用时的 query/candidate vector consistency；
- 配置中的上限和权重。

它不会自动发送候选文本到网络，也不会要求 \`ExternalReranker\` 注入。

## 边界

- gate 默认关闭；
- 没有 propagation 或 candidate tags 时会保持候选或跳过；
- 关闭本阶段不会影响基础向量/BM25；
- support 分数不是概率，不能跨不同配置直接比较；
- 发生数值/数据错误时，应查看 envelope 的 failure 字段和 engine 日志。

源码：[propagation-support-reranker.ts](../../src/stages/tag-retrieval/propagation-support-reranker.ts)。
