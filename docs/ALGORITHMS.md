# ALGORITHMS — 算法族数学说明

> 本文逐节说明 `src/algorithms/` 下八个纯算法模块的数学定义、默认参数与
> 使用语境。所有公式、默认值与取值为源码直读结果（波次传播 / 标度场求解 /
> 河流可见性 / EPA / 残差金字塔 / Gram-Schmidt / SVD-PCA / 结果去重），
> 每节末尾附对应测试文件指引。行为争议以本节引用行号为准。

## 1. 浪潮传播（src/algorithms/wave-propagation.ts）

激活尖峰沿标签共现图传播：种子点以初能量 `energy`（默认 1）进入
`activeSpikes`，每次跃迁按

```
注入电流 I = E_源 × w(共现权重) × decay × flowFactor
动量: 每普通跃迁耗 1（wormhole 边 0 耗）；momentum < 0 则停止
```

累计读入采用**带脉冲响应（FIR）读出**：`E_target += I × firWeights[hop]`，
权重由 `computeFirWeights(gamma, maxSafeHops)`（wave-propagation.ts:51）给出

```
w_h = γ^h / Σ_{h'=0}^{taps} γ^h'  ,   γ ∈ [0.05, 0.95]（默认 0.6），taps = maxHops（默认 4）
```

该项产出读取舍入归一化为单位和的衰减权重 —— 越近跳能量占比越大，实现
"软非回溯"读出的 hop 衰减。`adjacencyFromEdges(edges)`
（wave-propagation.ts:126）把 `[from, to, weight]` 三元组（或对象）聚合为
`Map<nodeId, Map<neighborId, weight>>`，重复边权重累加、非法边拒绝。

`propagate()`（wave-propagation.ts:185）默认值：`maxSafeHops=4`、
`baseMomentum=2.0`、`firingThreshold=0.10`、`baseDecay=0.25`、
`wormholeDecay=0.70`、`tensionThreshold=1.0`、`maxNeighborsPerNode=20`、
`returnFlowFactor=0.15`、`pruneAbove=0`（wave-propagation.ts:187–206）。
出参 `riverGraph` 含 `normalizedEnergy` 与 `normalizedFlow`（相对峰归一，
387–450）。测试见 `tests/stages/test-tagmemo-stages.test.ts:40–98`
（衰减/分支/虫洞/剪枝）与 `tests/algorithms/topology/
test-scaled-field-solver.test.ts`（行归一化算子侧）。

## 2. 缩放场求解（src/algorithms/topology/scaled-field-solver.ts）

V10 对偶标度场定点迭代求解器：

```
u = (1−α)·S + α·T(u)          （不动点方程，分两尺度迭代：
u_{k+1} = (1−α)·S + α·T(u_k)   local α=0.15 / transfer α=0.55；
                               ‖u_{k+1} − u_k‖₁ ≤ 1e-9 或 80 轮收敛）
```

- `buildRowOperator(adjacency, {weightFn})`（scaled-field-solver.ts:50）
  把共现邻接行归一化为确定性线性算子（行和 = 1，按目标下标排序），
  提供 `apply`（稠密乘法）与 `forEachEdge`；并要求 source/target 都在
  节点空间中，否则忽略。
- `normalizeSource(operator, sourceField)`（:149）把标签能量场散进节点空间
  并归一化为总质量 1 的 `Float64Array`。**空源（总质量 ≤ 0）抛
  `TAGMEMO_V10_EMPTY_SOURCE`**（:175–176）——这是 stage 侧断言"必须携带
  正质量源场"的哨兵错误，语义为查询项残缺时禁止继续迭代（测试
  `tests/algorithms/topology/test-scaled-field-solver.test.ts:54`）。
- `effectiveSupport(vector, operator, {method, massRatio})`（:191）按
  method 选择支持域萃取：默认 `mass_ratio`（按质量占比 ≥90% 截尾；
  `shannon` = 香农有效尺寸；`participation_ratio` = 参与比；
  `spectral_gap` = 最大谱隙断点），返回 `{ids, size, retainedMassRatio, ...}`。
- `solveDualScaledFields`（:312）产出 `localField/transferField` 两个
  实体域，`localSupport.massRatio=0.8`、`transferSupport.massRatio=0.9`
  默认（:437–446），`diagnostics` 含收敛标志、质量增量与 operator 签名。

测试：`tests/algorithms/topology/test-scaled-field-solver.test.ts`（收敛、
空源错误码、错误方法和 operator 空间不一致等 10 个用例）；下游消费见
`src/stages/memo/tagmemo-v10.ts`。

## 3. 河流可见性（src/algorithms/topology/river-observability.ts）

`computeRiverObservability(riverGraph, options)`（river-observability.ts:55）
把查询尖峰河流分类为 `dense / sparse / collapsed` 三态，基于三个子观测量的
几何均值：

```
ω_edge   = min(1, activeEdges / (κ_edge · seeds))          κ_edge=0.5
ω_emerge = min(1, emergentNodes / (κ_ratio · seeds))        κ_ratio=0.3
ω_flow   = H(p) = Σ −p·ln p / ln(#edges)（归一化流熵，空流=0 单流=0.5）
Ω = min(1, cbrt(max(ω_e,ε)·max(ω_m,ε)·max(ω_f,ε)) · 观察系数)
   观察系数 = 1（completeObservation）或 0.5；ε = 0.02 为几何下界
```

regime：`Ω < 0.12 → collapsed`；`0.12 ≤ Ω < 0.45 → sparse`；`≥ 0.45 → dense`
（:116–121）。用途：RAG 侧决定是否把"沉积、似河"查询提升为完整河流
语义路径（RiverMemo 阶段消费，见 `src/stages/memo/rivermemo.ts`）。
测试：`tests/stages/test-tagmemo-stages.test.ts:155`（空河坍缩 / 富河稠密）。

## 4. EPA（src/algorithms/epa.ts）

Embedding Projection Analysis：把 3072 维向量向标签正交基底投影后解读

```
p_k   = <v − v̄, u_k>                       （去均值投影，:85–99）
q_k   = p_k² / Σp²  （= 轴能量密度，Σ q_k = 1）
H     = 归一化熵 = Σ −q_k·log₂ q_k / log₂ K    （K = 基底数，:113）
logicDepth = 1 − H      ∈ [0,1]，越大越"聚焦单一主轴"
主轴 = {k : q_k > 0.05}（:117，dominantAxes）
```

cos 共振：`coActivation = √(e₁·e₂)`，`e₁`/`e₂` 为主轴能量占比；
`coActivation > 0.15` 计为桥梁桥（:142–165），`resonance = Σ bridges.strength`
表示跨域多轴同步激活。三量取值域与含义：`logicDepth ∈ [0,1]`
（1 = 完全聚焦，0 = 完全平坦 / 或未初始化返回 `{logicDepth:0, entropy:1}`，
:214–216）；`resonance ≥ 0`；`probabilities` 非负且和为 1。
`EPA.computeBasis`（:174）用 K-Means（clusterCount 默认 64）+ 加权
PCA（maxBasisDim 64）建基底。测试：`tests/algorithms/test-epa.test.ts`
（logicDepth、共振、computeBasis）。

## 5. 残差金字塔（src/algorithms/residual-pyramid.ts）

逐层剥离最相似标签的向量空间贡献，直到层数或能量余量终止：

```
第 level 层：searchFn(currentResidual, topK=10) → 标签向量
  P = orthogonalProjection(currentResidual, tags)      # Gram-Schmidt 投影
  r = currentResidual − P（残差 = 下一层输入）
  explained_level = (‖v‖² − ‖r‖²) / ‖v₀‖²
终止：‖r‖²/‖v₀‖² < minEnergyRatio=0.1 或达到 maxLevels=3
```

出参 `pyramid.totalExplainedEnergy`（累计覆盖率）、`finalResidual`、
`handshakeFeatures`（方向一致度 / 模式强度 / 新异信号，基于残差方向向量的
成对余弦，:148–221）。`extractFeatures`（:223）汇聚为
`coverage = min(1, totalExplainedEnergy)`、`novelty = 0.7·(1−coverage)
+ 0.3·directionalNovelty`、`tagMemoActivation = coverage·coherence·
(1−noiseSignal)`。统计语义：层数上限诚实封顶 3 层，`depth` 反映标签
清晰度。
Rust 加速可用时（`config.vexusIndex.computeOrthogonalProjection /
computeHandshakes`）走原生路径，失败回退 JS。测试：
`tests/algorithms/test-residual-pyramid.test.ts`（零能量、分层分解、
features 空金字塔）。

## 6. Gram-Schmidt（src/algorithms/gram-schmidt.ts）

朴素版原始基元，全部为纯数学：

```
dotProduct(u, v)   = Σ uᵢvᵢ
magnitude(v)       = √(Σ vᵢ²)
normalize(v)       = v / ‖v‖；‖v‖ < 1e-9 → 零向量
orthogonalize(V)   ，修改版：u_i = v_i − Σ_{j<i} ⟨v_i, u_j⟩ u_j，
                       归一化；‖·‖ ≤ 1e-6 视为线性相关丢弃
orthogonalProjection(x, V) ：P = Σᵢ ⟨x, uᵢ⟩ uᵢ ,  R = x − P
```

用途：残余金字塔与 EPA 基底的向量空间操作基础（`src/algorithms/
residual-pyramid.ts:10` 引用）。测试：`tests/algorithms/
test-gram-schmidt.test.ts`（内积、L2 范数、单位化、MGS 正交性、
线性相关向量、投影/残差）。

## 7. SVD / PCA（src/algorithms/svd.ts）

加权主成分提取链路（由 EPAModule 提取，全部纯内存）：

```
clusterTags(tags, k, dim)     伪 K-Means（Forgy 随机种子，≤50 迭代，tol 1e-4，
                              空簇用点到质心最远样本重初始化；质心按最接近
                              原始 tag 命名（labels）
computeWeightedPCA(cluster, dim, {maxBasisDim=64, strictOrtho=true})
  μ̄ = Σ wᵢxᵢ / Σ wᵢ；X̃ = √wᵢ(xᵢ − μ̄)
  Gram 矩阵 G = X̃ X̃ᵀ ∈ R^(n×n)
  幂迭代求特征向量 λ、v（max 100 轮，1e-6 收敛）；每次消去 λvvᵀ
  U 轴 = X̃ᵀ v / √λ（映射回原空间）
powerIteration(matrix, n, existingBasis[, strict])   # 见上，逐幂正交化
selectBasisDimension(S)  累计贡献 Σλᵢ/Σλ ≥ 0.95 → 返回 i+1（下限 8）
```

意义：EPA 的基底降维器 —— 用原始标签空间的低秩主轴压为「基底」；
少于 8 或 95% 方差未累积齐时取全体。测试：`tests/algorithms/
test-svd.test.ts`（clusterTags 聚类、加权 PCA 提取主成分、
selectBasisDimension 95% / 下限 8）。

## 8. ResultDeduplicator（src/algorithms/result-deduplicator.ts）

多路召回候选的统一去重（硬去重 + 语义去重两层）：

```
硬去重（hardDeduplicate，:114-161）：identity ∈ {chunk:id, text:NFKC-规范化文本,
                     path-chunk:posix-fullpath:chunkIndex}
   同 identity 只保留 sourcePriority 更高 / rerank_score 更高 /
   完整性更高的候选（_isPreferredCandidate，:253-263）
语义去重（_semanticDeduplicate，:163-205）：候选与已选代表之间两两余弦
   ≥ semanticThreshold（默认 0.92）视为冗余；无向量候选一律保留
   （避免静默丢 BM25/外部结果）；阈值可经构造/updateConfig 覆盖
数学：sim(v1,v2) = ⟨v1,v2⟩ / (‖v1‖‖v2‖)，任一范数 ≤ 1e-12 → 返回 −1
```

出参按 来源优先级 + 分数 + 原始次序 稳定排序（`_compareOutputOrder`）。
属于 Rust 查询主链之外的后处理件，服务 candidate / postprocess stage
（`src/stages/postprocess/result-deduplicator.ts` 包装）。测试：
`tests/stages/test-postprocess-stages.test.ts`（:48 硬去重、:73 语义
近重复抑制、:95 阈值下保留）。

## 9. 验证与限制

- 上文所有默认值均逐一对应 `src/algorithms/*` 源码行内注释；行为级验证
  见各节测试文件，另有 `tests/stages/test-tagmemo-stages.test.ts` 把
  算法组装进 V9/V10/RiverMemo 阶段的端到端断言。
- 算法函数均为纯计算，无 I/O（`src/algorithms/` 全树无 db/vexusIndex
  引用）；有 Rust 加速的调用点均带 JS 回退。维度/容量参数与
  `PERSISTENCE.md` 的索引维度约束一致。
