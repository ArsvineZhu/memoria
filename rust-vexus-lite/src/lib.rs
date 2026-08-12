#![deny(clippy::all)]
#![allow(
    clippy::manual_is_multiple_of,
    clippy::needless_range_loop,
    clippy::same_item_push,
    clippy::too_many_arguments,
    clippy::type_complexity
)]

mod persistence;
mod propagation_structure_reranker;
mod propagation_support_native;
mod tag_basis;
mod tag_graph_artifact_builder;
mod tag_graph_observation;
mod tag_pair_similarity;
mod tag_residual;
mod tag_retrieval_pipeline;
mod vector_index;
mod watcher;

use propagation_structure_reranker::TagRetrievalRuntime;
use tag_pair_similarity::cosine_similarity;
use tag_residual::{
    compute_anchored_gs_residual, compute_centroid_residual, compute_svd_residual, pair_key,
    semantic_gate, tag_residual_method_from_name, tag_residual_method_name, TagResidualConfig,
    TagResidualConfigInput, TagResidualMethod, TagResidualNeighbor,
};

use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, RwLock};
use usearch::Index;

pub use watcher::{VexusWatcher, WatcherConfig};

/// 搜索结果 (返回 ID 而非 Tag 文本)
/// 上层 JS 会拿着 ID 去 SQLite 里查具体的文本内容
#[napi(object)]
pub struct SearchResult {
    pub id: i64, // 对应 SQLite 中的 chunks.id 或 tags.id
    pub score: f64,
}

#[napi(object)]
pub struct ResidualDirectionsResult {
    pub projection: Vec<f64>,
    pub residual: Vec<f64>,
    pub basis_coefficients: Vec<f64>,
}

#[napi(object)]
pub struct TagBasisProjectionResult {
    pub projections: Vec<f64>,
    pub probabilities: Vec<f64>,
    pub entropy: f64,
    pub total_energy: f64,
}

#[napi(object)]
pub struct DiffusionDistributionResult {
    pub local_vector: Option<Vec<f64>>,
    pub extended_vector: Option<Vec<f64>>,
    pub requested_count: u32,
    pub found_count: u32,
    pub missing_count: u32,
    pub local_total_weight: f64,
    pub transfer_total_weight: f64,
    pub elapsed_ms: f64,
}

#[napi(object)]
pub struct TagContextFusionResult {
    pub vector: Vec<f64>,
    pub selected_tag_ids: Vec<i64>,
    pub requested_count: u32,
    pub found_count: u32,
    pub deduplicated_count: u32,
    pub total_weight: f64,
    pub elapsed_ms: f64,
}

#[napi(object)]
pub struct TagResidualMetricsResult {
    pub tag_count: u32,
    pub computed_count: u32,
    pub skipped_count: u32,
    pub elapsed_ms: f64,
    pub algorithm_version: String,
    pub artifact_sig: String,
    pub effective_config: String,
}

/// 🌟 TagBasisProjection Rust 基底重算结果
#[napi(object)]
pub struct TagBasisResult {
    pub success: bool,
    pub message: String,
    pub tag_count: u32,
    pub cluster_count: u32,
    pub basis_count: u32,
    pub elapsed_ms: f64,
    pub algorithm: String,
    pub phase_summary: String,
    pub anchor_count: u32,
    pub representative_sample_count: u32,
    pub density_bucket_count: u32,
    pub publish_elapsed_ms: f64,
}

/// Canonical tag-pair similarity precomputation result.
#[napi(object)]
pub struct TagPairSimilarityResult {
    pub pair_count: u32,     // 实际共现 pair 总数 (经单文件≤100守恒后)
    pub computed_count: u32, // 本次实际完成余弦计算的 pair 数
    pub skipped_count: u32,  // 已有缓存、缺失向量或 sim 低于阈值被丢弃的 pair 数
    pub stored_count: u32,   // 实际写入数据库的 pair 数 (sim >= min_similarity)
    pub elapsed_ms: f64,
}

/// 统计信息
#[napi(object)]
pub struct VexusStats {
    pub total_vectors: u32,
    pub dimensions: u32,
    pub capacity: u32,
    pub memory_usage: f64,
}

/// VexusIndex-owned tag retrieval runtime diagnostics.
#[napi(object)]
pub struct TagRetrievalRuntimeStats {
    pub active_artifact_sig: Option<String>,
    pub generation: i64,
    pub node_count: u32,
    pub edge_count: u32,
    pub resident: bool,
}

/// 核心索引结构 (无状态，只存向量)
#[napi]
pub struct VexusIndex {
    index: Arc<RwLock<Index>>,
    dimensions: u32,
    tag_basis_pending_cache: Arc<std::sync::Mutex<Option<TagBasisPendingCache>>>,
    /// Tag association graph artifact runtime shared by associative and structural retrieval.
    /// 与本 VexusIndex 实例同生命周期，禁止使用进程全局生产缓存。
    tag_retrieval_runtime: Arc<TagRetrievalRuntime>,
}

#[napi]
impl VexusIndex {
    /// 创建新的空索引
    #[napi(constructor)]
    pub fn new(dim: u32, capacity: u32) -> Result<Self> {
        let index = vector_index::create_index(dim, capacity).map_err(Error::from_reason)?;

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
            tag_basis_pending_cache: Arc::new(std::sync::Mutex::new(None)),
            tag_retrieval_runtime: Arc::new(TagRetrievalRuntime::new()),
        })
    }

    /// 从磁盘加载索引
    /// 映射关系由 SQLite 管理。
    #[napi(factory)]
    pub fn load(index_path: String, dim: u32, capacity: u32) -> Result<Self> {
        let index =
            vector_index::load_index(&index_path, dim, capacity).map_err(Error::from_reason)?;

        Ok(Self {
            index: Arc::new(RwLock::new(index)),
            dimensions: dim,
            tag_basis_pending_cache: Arc::new(std::sync::Mutex::new(None)),
            tag_retrieval_runtime: Arc::new(TagRetrievalRuntime::new()),
        })
    }

    /// 保存索引到磁盘。
    ///
    /// 临时文件始终与目标位于同一目录，保证 rename 不跨文件系统。Unix 使用
    /// 原子覆盖并同步父目录；Windows 使用可回滚备份交换，并对杀毒软件、索引器
    /// 短暂持有句柄造成的共享冲突进行有界重试。
    #[napi]
    pub fn save(&self, index_path: String) -> Result<()> {
        // save 会发布共享磁盘状态；使用写锁串行化同一 VexusIndex 实例的保存，
        // 避免多个读锁持有者同时争抢目标文件。唯一 sidecar 名仍防御多实例碰撞。
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;
        vector_index::save_index_atomic(&index, &index_path).map_err(Error::from_reason)?;

        Ok(())
    }

    /// 单个添加 (JS 循环调用)
    #[napi]
    pub fn add(&self, id: i64, vector: Float32Array) -> Result<()> {
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let vec_slice: &[f32] = &vector;

        if vec_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Dimension mismatch: expected {}, got {}",
                self.dimensions,
                vec_slice.len()
            )));
        }

        // 自动扩容检查
        if index.size() + 1 >= index.capacity() {
            let new_cap = (index.capacity() as f64 * 1.5) as usize;
            index
                .reserve(new_cap)
                .map_err(|e| Error::from_reason(format!("Auto-expand failed: {:?}", e)))?;
        }

        index
            .add(id as u64, vec_slice)
            .map_err(|e| Error::from_reason(format!("Add failed: {:?}", e)))?;

        Ok(())
    }

    /// 批量添加 (FFI 优化版)
    /// 注意：这目前是一个“伪批量”实现，主要通过减少 JS/Rust 跨界调用开销来提速。
    /// 内部依然是逐条 add，但避免了多次获取写锁的开销。
    #[napi]
    pub fn add_batch(&self, ids: Vec<i64>, vectors: Float32Array) -> Result<()> {
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let count = ids.len();
        let dim = self.dimensions as usize;

        let vec_slice: &[f32] = &vectors;

        if vec_slice.len() != count * dim {
            return Err(Error::from_reason("Batch size mismatch".to_string()));
        }

        // 预扩容
        if index.size() + count >= index.capacity() {
            let new_cap = ((index.size() + count) as f64 * 1.5) as usize;
            index
                .reserve(new_cap)
                .map_err(|e| Error::from_reason(format!("Batch auto-expand failed: {:?}", e)))?;
        }

        for (i, id) in ids.iter().enumerate() {
            let start = i * dim;
            let v = &vec_slice[start..start + dim];
            // multi=false 下重复 key 直接 add 会报 duplicate key；
            // 先尽力 remove 再 add，使批量路径与单条“重嵌入更新”语义一致。
            let _ = index.remove(*id as u64);
            index.add(*id as u64, v).map_err(|e| {
                Error::from_reason(format!(
                    "Batch add/update failed idx {} id {}: {:?}",
                    i, id, e
                ))
            })?;
        }

        Ok(())
    }

    /// 搜索
    #[napi]
    pub fn search(&self, query: Float32Array, k: u32) -> Result<Vec<SearchResult>> {
        let index = self
            .index
            .read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        let query_slice: &[f32] = &query;

        // 🔥🔥🔥【新增】维度安全检查 🔥🔥🔥
        if query_slice.len() != self.dimensions as usize {
            return Err(Error::from_reason(format!(
                "Search dimension mismatch: expected {}, got {}. (Check your JS Buffer slicing!)",
                self.dimensions,
                query_slice.len()
            )));
        }

        // 执行搜索
        let matches = index
            .search(query_slice, k as usize)
            .map_err(|e| Error::from_reason(format!("Search failed: {:?}", e)))?;

        let mut results = Vec::with_capacity(matches.keys.len());

        for (key, &dist) in matches.keys.iter().zip(matches.distances.iter()) {
            results.push(SearchResult {
                id: *key as i64,
                score: 1.0 / (1.0 + dist as f64), // L2sq 距离转相似度分数
            });
        }

        Ok(results)
    }

    /// PropagationStructure 全局双场投影。
    ///
    /// Tag 向量直接从当前常驻 usearch F32 索引按 key 读取；整个查询只复用一个
    /// dimension 大小的临时缓冲区，不维护第二份全库向量矩阵。
    #[napi]
    pub fn project_diffusion_distributions(
        &self,
        tag_ids: Vec<i64>,
        local_masses: Float64Array,
        transfer_masses: Float64Array,
    ) -> Result<DiffusionDistributionResult> {
        let started_at = std::time::Instant::now();
        let dim = self.dimensions as usize;
        let local_weights: &[f64] = &local_masses;
        let transfer_weights: &[f64] = &transfer_masses;

        if local_weights.len() != tag_ids.len() || transfer_weights.len() != tag_ids.len() {
            return Err(Error::from_reason(format!(
                "Dual projection size mismatch: ids={}, local={}, transfer={}",
                tag_ids.len(),
                local_weights.len(),
                transfer_weights.len()
            )));
        }

        let index = self
            .index
            .read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;
        let mut tag_vector = vec![0.0f32; dim];
        let mut local_output = vec![0.0f64; dim];
        let mut transfer_output = vec![0.0f64; dim];
        let mut local_total_weight = 0.0f64;
        let mut transfer_total_weight = 0.0f64;
        let mut found_count = 0usize;

        for (position, &tag_id) in tag_ids.iter().enumerate() {
            let local_mass = local_weights[position].max(0.0);
            let transfer_mass = transfer_weights[position].max(0.0);
            if tag_id <= 0
                || (!local_mass.is_finite() && !transfer_mass.is_finite())
                || (local_mass <= 0.0 && transfer_mass <= 0.0)
            {
                continue;
            }

            let local_mass = if local_mass.is_finite() {
                local_mass
            } else {
                0.0
            };
            let transfer_mass = if transfer_mass.is_finite() {
                transfer_mass
            } else {
                0.0
            };
            let matches = index.get(tag_id as u64, &mut tag_vector).map_err(|e| {
                Error::from_reason(format!(
                    "Failed to read Tag vector {} from usearch: {:?}",
                    tag_id, e
                ))
            })?;
            if matches == 0 {
                continue;
            }

            found_count += 1;
            for dimension in 0..dim {
                let value = tag_vector[dimension] as f64;
                if local_mass > 0.0 {
                    local_output[dimension] += value * local_mass;
                }
                if transfer_mass > 0.0 {
                    transfer_output[dimension] += value * transfer_mass;
                }
            }
            local_total_weight += local_mass;
            transfer_total_weight += transfer_mass;
        }

        let finalize = |mut output: Vec<f64>, total_weight: f64| -> Option<Vec<f64>> {
            if total_weight <= 0.0 {
                return None;
            }
            let mut norm_sq = 0.0f64;
            for value in output.iter_mut() {
                *value /= total_weight;
                norm_sq += *value * *value;
            }
            let norm = norm_sq.sqrt();
            if norm <= 1e-12 {
                return None;
            }
            for value in output.iter_mut() {
                *value /= norm;
            }
            Some(output)
        };

        Ok(DiffusionDistributionResult {
            local_vector: finalize(local_output, local_total_weight),
            extended_vector: finalize(transfer_output, transfer_total_weight),
            requested_count: tag_ids.len() as u32,
            found_count: found_count as u32,
            missing_count: tag_ids.len().saturating_sub(found_count) as u32,
            local_total_weight,
            transfer_total_weight,
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 使用当前 VexusIndex 唯一 Tag 向量空间完成 tag context fusion。
    ///
    /// 只在批量读取请求涉及的 Tag 向量时短持 usearch 读锁；语义去重、
    /// 上下文加权和最终融合均在释放索引锁后执行，不维护第二份全库向量。
    #[napi]
    pub fn fuse_tag_context(
        &self,
        original: Float32Array,
        tag_ids: Vec<i64>,
        tag_weights: Float64Array,
        alpha: f64,
        dedup_threshold: Option<f64>,
        max_tags: Option<u32>,
    ) -> Result<TagContextFusionResult> {
        let started_at = std::time::Instant::now();
        let dim = self.dimensions as usize;
        let source: &[f32] = &original;
        let weights: &[f64] = &tag_weights;
        if source.len() != dim {
            return Err(Error::from_reason(format!(
                "Tag context fusion dimension mismatch: expected {}, got {}",
                dim,
                source.len()
            )));
        }
        if tag_ids.len() != weights.len() {
            return Err(Error::from_reason(format!(
                "Tag context fusion input mismatch: ids={}, weights={}",
                tag_ids.len(),
                weights.len()
            )));
        }

        let requested_count = tag_ids.len();
        let mut requested: Vec<(i64, f64)> = tag_ids
            .into_iter()
            .zip(weights.iter().copied())
            .filter_map(|(id, weight)| {
                let weight = if weight.is_finite() {
                    weight.max(0.0)
                } else {
                    0.0
                };
                (id > 0 && weight > 0.0).then_some((id, weight))
            })
            .collect();
        requested.sort_by(|left, right| {
            right
                .1
                .partial_cmp(&left.1)
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| left.0.cmp(&right.0))
        });
        requested.truncate(max_tags.unwrap_or(128).clamp(1, 1024) as usize);

        let mut vectors: Vec<(i64, f64, Vec<f32>, f64)> = Vec::with_capacity(requested.len());
        {
            let index = self.index.read().map_err(|error| {
                Error::from_reason(format!("Tag context fusion index lock failed: {}", error))
            })?;
            let mut buffer = vec![0.0f32; dim];
            for (id, weight) in requested {
                let matches = index.get(id as u64, &mut buffer).map_err(|error| {
                    Error::from_reason(format!(
                        "Tag context fusion failed to read Tag vector {}: {:?}",
                        id, error
                    ))
                })?;
                if matches == 0 {
                    continue;
                }
                let norm = buffer
                    .iter()
                    .map(|value| (*value as f64) * (*value as f64))
                    .sum::<f64>()
                    .sqrt();
                if norm <= 1e-12 {
                    continue;
                }
                vectors.push((id, weight, buffer.clone(), norm));
            }
        }

        let found_count = vectors.len();
        let threshold = dedup_threshold.unwrap_or(0.88).clamp(-1.0, 1.0);
        let mut selected: Vec<(i64, f64, Vec<f32>, f64)> = Vec::new();
        for (id, weight, vector, norm) in vectors {
            let redundant = selected.iter().any(|(_, _, existing, existing_norm)| {
                let dot = vector
                    .iter()
                    .zip(existing.iter())
                    .map(|(left, right)| (*left as f64) * (*right as f64))
                    .sum::<f64>();
                dot / (norm * *existing_norm) > threshold
            });
            if !redundant {
                selected.push((id, weight, vector, norm));
            }
        }

        let mut context = vec![0.0f64; dim];
        let total_weight: f64 = selected.iter().map(|entry| entry.1).sum();
        if total_weight > 0.0 {
            for (_, weight, vector, _) in &selected {
                for dimension in 0..dim {
                    context[dimension] += vector[dimension] as f64 * *weight;
                }
            }
            for value in &mut context {
                *value /= total_weight;
            }
            let context_norm = context
                .iter()
                .map(|value| value * value)
                .sum::<f64>()
                .sqrt();
            if context_norm > 1e-12 {
                for value in &mut context {
                    *value /= context_norm;
                }
            }
        }

        let mix = if alpha.is_finite() {
            alpha.clamp(0.0, 1.0)
        } else {
            0.0
        };
        let mut fused: Vec<f64> = source
            .iter()
            .zip(context.iter())
            .map(|(source_value, context_value)| {
                (1.0 - mix) * (*source_value as f64) + mix * *context_value
            })
            .collect();
        let fused_norm = fused.iter().map(|value| value * value).sum::<f64>().sqrt();
        if fused_norm > 1e-12 {
            for value in &mut fused {
                *value /= fused_norm;
            }
        }

        Ok(TagContextFusionResult {
            vector: fused,
            selected_tag_ids: selected.iter().map(|entry| entry.0).collect(),
            requested_count: requested_count as u32,
            found_count: found_count as u32,
            deduplicated_count: selected.len() as u32,
            total_weight,
            elapsed_ms: started_at.elapsed().as_secs_f64() * 1000.0,
        })
    }

    /// 在本 Tag 向量索引与 TagRetrievalRuntime 上执行统一查询数学管线。
    ///
    /// TagBasisProjection、Residual TagResidualDecomposition、Core/语言/层级门控、activation propagation 与向量融合全部在
    /// 同一 Rust 后台任务中完成；返回值同时供 propagation-support 和
    /// propagation-structure 读出复用。
    #[napi]
    pub fn run_tag_retrieval_pipeline(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<tag_retrieval_pipeline::TagRetrievalPipelineTask> {
        tag_retrieval_pipeline::run_with_runtime(
            self.index.clone(),
            self.tag_retrieval_runtime.clone(),
            db_path,
            artifact_sig,
            self.dimensions as usize,
            input_json,
        )
    }

    /// 在本 Tag 向量索引拥有的统一 TagRetrievalRuntime 上执行共同 activation observation。
    ///
    /// 输入只包含 TagBasisProjection/TagResidualDecomposition 门控后的初始 Tag 种子与传播参数；输出的
    /// QueryObservation 同时供 propagation-support 和 propagation-structure 两个读出头消费。
    #[napi]
    pub fn run_activation_propagation(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<tag_graph_observation::ActivationPropagationTask> {
        tag_graph_observation::observe_with_runtime(
            self.tag_retrieval_runtime.clone(),
            db_path,
            artifact_sig,
            input_json,
        )
    }

    /// 在统一 QueryObservation 上执行 propagation-support 读出。
    ///
    /// 与 propagation-structure 读取同一个 TagRetrievalRuntime 活动图快照；
    /// 差异只存在于读出方程，不再拥有独立图资产。
    #[napi]
    pub fn rerank_by_propagation_support(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<propagation_support_native::PropagationSupportRerankerTask> {
        propagation_support_native::rerank_with_runtime(
            self.tag_retrieval_runtime.clone(),
            db_path,
            artifact_sig,
            input_json,
        )
    }

    /// 在本 Tag 向量索引拥有的统一 TagRetrievalRuntime 上执行 propagation-structure 读出。
    ///
    /// 首次请求从持久化资产恢复 CSR，随后由本 VexusIndex 实例持有活动 Arc 快照；
    /// 查询只克隆快照，不再访问进程全局生产缓存。
    #[napi]
    pub fn rerank_by_propagation_structure(
        &self,
        db_path: String,
        artifact_sig: String,
        input_json: String,
    ) -> AsyncTask<propagation_structure_reranker::PropagationStructureRerankerTask> {
        propagation_structure_reranker::rerank_with_runtime(
            self.tag_retrieval_runtime.clone(),
            db_path,
            artifact_sig,
            input_json,
        )
    }

    /// Build the canonical tag association graph artifact from SQLite facts and derived tables.
    ///
    /// 完整图、CSR、provenance、持久化 payload 与活动 Arc 均不跨越
    /// N-API 边界；JavaScript 只接收签名、代际与规模摘要。
    #[napi]
    pub fn rebuild_tag_graph_artifact(
        &self,
        db_path: String,
        input_json: String,
    ) -> AsyncTask<tag_graph_artifact_builder::TagRetrievalArtifactBuildTask> {
        tag_graph_artifact_builder::rebuild_with_runtime(
            self.tag_retrieval_runtime.clone(),
            db_path,
            input_json,
        )
    }

    /// Release the tag association graph artifact snapshot owned by this index.
    #[napi]
    pub fn clear_tag_retrieval_runtime(&self) -> Result<()> {
        self.tag_retrieval_runtime
            .clear()
            .map_err(Error::from_reason)
    }

    /// Return diagnostics for the resident tag association graph artifact snapshot.
    #[napi]
    pub fn tag_retrieval_runtime_stats(&self) -> Result<TagRetrievalRuntimeStats> {
        let (signature, generation, node_count, edge_count) = self
            .tag_retrieval_runtime
            .diagnostics()
            .map_err(Error::from_reason)?;
        Ok(TagRetrievalRuntimeStats {
            resident: signature.is_some(),
            active_artifact_sig: signature,
            generation: generation as i64,
            node_count: node_count as u32,
            edge_count: edge_count as u32,
        })
    }

    /// 删除 (按 ID)
    #[napi]
    pub fn remove(&self, id: i64) -> Result<()> {
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        index
            .remove(id as u64)
            .map_err(|e| Error::from_reason(format!("Remove failed: {:?}", e)))?;

        Ok(())
    }

    /// 获取当前索引状态
    #[napi]
    pub fn stats(&self) -> Result<VexusStats> {
        let index = self
            .index
            .read()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        Ok(VexusStats {
            total_vectors: index.size() as u32,
            dimensions: self.dimensions,
            capacity: index.capacity() as u32,
            memory_usage: index.memory_usage() as f64,
        })
    }

    /// 从 SQLite 数据库恢复索引 (异步版本，不阻塞主线程)
    #[napi]
    pub fn recover_from_sqlite(
        &self,
        db_path: String,
        table_type: String,
        filter_space: Option<String>,
    ) -> AsyncTask<RecoverTask> {
        AsyncTask::new(RecoverTask {
            index: self.index.clone(),
            db_path,
            table_type,
            filter_space,
            dimensions: self.dimensions,
        })
    }

    /// 高性能 Gram-Schmidt 正交投影
    #[napi]
    pub fn compute_residual_directions(
        &self,
        vector: Float32Array,
        flattened_tags: Float32Array,
        n_tags: u32,
    ) -> Result<ResidualDirectionsResult> {
        let dim = self.dimensions as usize;
        let n = n_tags as usize;

        let query: &[f32] = &vector;
        let tags_slice: &[f32] = &flattened_tags;

        if query.len() != dim || tags_slice.len() != n * dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut basis: Vec<Vec<f64>> = Vec::with_capacity(n);
        let mut basis_coefficients = vec![0.0; n];
        let mut projection = vec![0.0; dim];

        for i in 0..n {
            let start = i * dim;
            let tag_vec = &tags_slice[start..start + dim];
            let mut v: Vec<f64> = tag_vec.iter().map(|&x| x as f64).collect();

            for u in &basis {
                let mut dot = 0.0;
                for d in 0..dim {
                    dot += v[d] * u[d];
                }
                for d in 0..dim {
                    v[d] -= dot * u[d];
                }
            }

            let mut mag_sq = 0.0;
            for d in 0..dim {
                mag_sq += v[d] * v[d];
            }
            let mag = mag_sq.sqrt();

            if mag > 1e-6 {
                for d in 0..dim {
                    v[d] /= mag;
                }

                let mut coeff = 0.0;
                for d in 0..dim {
                    coeff += (query[d] as f64) * v[d];
                }
                basis_coefficients[i] = coeff.abs();

                for d in 0..dim {
                    projection[d] += coeff * v[d];
                }
                basis.push(v);
            }
        }

        let mut residual = vec![0.0; dim];
        for d in 0..dim {
            residual[d] = (query[d] as f64) - projection[d];
        }

        Ok(ResidualDirectionsResult {
            projection,
            residual,
            basis_coefficients,
        })
    }

    /// 高性能 TagBasisProjection 投影
    #[napi]
    pub fn project_tag_basis(
        &self,
        vector: Float32Array,
        flattened_basis: Float32Array,
        mean_vector: Float32Array,
        k: u32,
    ) -> Result<TagBasisProjectionResult> {
        let dim = self.dimensions as usize;
        let k = k as usize;

        let vec: &[f32] = &vector;
        let basis_slice: &[f32] = &flattened_basis;
        let mean: &[f32] = &mean_vector;

        if vec.len() != dim || basis_slice.len() != k * dim || mean.len() != dim {
            return Err(Error::from_reason("Dimension mismatch".to_string()));
        }

        let mut centered = vec![0.0; dim];
        for d in 0..dim {
            centered[d] = (vec[d] - mean[d]) as f64;
        }

        let mut projections = vec![0.0; k];
        let mut total_energy = 0.0;

        for i in 0..k {
            let start = i * dim;
            let b = &basis_slice[start..start + dim];
            let mut dot = 0.0;
            for d in 0..dim {
                dot += centered[d] * (b[d] as f64);
            }
            projections[i] = dot;
            total_energy += dot * dot;
        }

        let mut probabilities = vec![0.0; k];
        let mut entropy = 0.0;

        if total_energy > 1e-12 {
            for i in 0..k {
                let p = (projections[i] * projections[i]) / total_energy;
                probabilities[i] = p;
                if p > 1e-9 {
                    entropy -= p * p.log2();
                }
            }
        }

        Ok(TagBasisProjectionResult {
            projections,
            probabilities,
            entropy,
            total_energy,
        })
    }

    /// 🌟 TagBasisProjection: Rust 侧重算基底并暂存在 Rust 内存中。
    ///
    /// 计算阶段只读 SQLite，不持有 JS 写租约；调用方应在结果成功后短租约调用 publish_tag_basis_projection_basis_cache。
    #[napi]
    pub fn compute_tag_basis(
        &self,
        db_path: String,
        cluster_count: u32,
        max_basis_dim: u32,
    ) -> AsyncTask<TagBasisTask> {
        println!(
            "[Vexus-Lite][TagBasisProjection] computeTagBasis task accepted: db={}, cluster_count={}, max_basis_dim={}",
            db_path,
            cluster_count,
            max_basis_dim
        );
        AsyncTask::new(TagBasisTask {
            db_path,
            dimensions: self.dimensions,
            cluster_count: cluster_count.max(8),
            max_basis_dim: max_basis_dim.max(1),
            pending_cache: self.tag_basis_pending_cache.clone(),
        })
    }

    /// 🌟 TagBasisProjection: 发布最近一次 Rust 计算完成的 TagBasisProjection cache。
    ///
    /// 该方法执行短 SQLite 写入，JS 调用方必须先获取 Rust 写租约。
    #[napi]
    pub fn publish_tag_basis_cache(&self, db_path: String) -> Result<TagBasisResult> {
        let pending = {
            let guard = self.tag_basis_pending_cache.lock().map_err(|e| {
                Error::from_reason(format!(
                    "TagBasisProjection pending cache lock failed: {}",
                    e
                ))
            })?;
            guard.clone()
        };

        let pending = match pending {
            Some(cache) => cache,
            None => {
                return Ok(TagBasisResult {
                    success: false,
                    message: "no pending TagBasisProjection basis cache to publish".to_string(),
                    tag_count: 0,
                    cluster_count: 0,
                    basis_count: 0,
                    elapsed_ms: 0.0,
                    algorithm: "density-residual-sampling".to_string(),
                    phase_summary: "publish=no_pending_cache".to_string(),
                    anchor_count: 0,
                    representative_sample_count: 0,
                    density_bucket_count: 0,
                    publish_elapsed_ms: 0.0,
                });
            }
        };

        let target_db_identity = sqlite_database_identity(&db_path);
        if target_db_identity != pending.db_identity {
            return Err(Error::from_reason(format!(
                "TagBasisProjection pending cache database mismatch: computed for {}, publish requested for {}",
                pending.db_identity, target_db_identity
            )));
        }

        println!(
            "[Vexus-Lite][TagBasisProjection] publishTagBasisCache started: db={}, tags={}, clusters={}, basis={}",
            db_path,
            pending.tag_count,
            pending.cluster_count,
            pending.basis_count
        );

        let started_at = std::time::Instant::now();
        let mut conn = persistence::open_sqlite_readwrite(&db_path)
            .map_err(|e| Error::from_reason(format!("DB write open/config failed: {}", e)))?;
        let tx = conn.transaction().map_err(|e| {
            Error::from_reason(format!(
                "TagBasisProjection cache transaction failed: {}",
                e
            ))
        })?;
        tx.execute(
            "INSERT OR REPLACE INTO kv_store (key, value) VALUES (?1, ?2)",
            rusqlite::params!["tag_basis_cache", pending.cache_json],
        )
        .map_err(|e| Error::from_reason(format!("TagBasisProjection cache write failed: {}", e)))?;
        tx.commit().map_err(|e| {
            Error::from_reason(format!("TagBasisProjection cache commit failed: {}", e))
        })?;

        {
            let mut guard = self.tag_basis_pending_cache.lock().map_err(|e| {
                Error::from_reason(format!(
                    "TagBasisProjection pending cache lock failed: {}",
                    e
                ))
            })?;
            if guard.as_ref().map(|cache| cache.cache_sig.as_str())
                == Some(pending.cache_sig.as_str())
            {
                *guard = None;
            }
        }

        let publish_ms = started_at.elapsed().as_secs_f64() * 1000.0;
        println!(
            "[Vexus-Lite][TagBasisProjection] publishTagBasisCache finished: publish_elapsed={:.2}ms, compute_elapsed={:.2}ms",
            publish_ms,
            pending.elapsed_ms
        );

        Ok(TagBasisResult {
            success: true,
            message: "ok".to_string(),
            tag_count: pending.tag_count,
            cluster_count: pending.cluster_count,
            basis_count: pending.basis_count,
            elapsed_ms: pending.elapsed_ms + publish_ms,
            algorithm: pending.algorithm,
            phase_summary: format!("{};publish={:.2}ms", pending.phase_summary, publish_ms),
            anchor_count: pending.anchor_count,
            representative_sample_count: pending.representative_sample_count,
            density_bucket_count: pending.density_bucket_count,
            publish_elapsed_ms: publish_ms,
        })
    }

    /// 预计算任务：tag residual metrics。
    #[napi]
    pub fn compute_tag_residual_metrics(
        &self,
        db_path: String,
        max_rank: Option<u32>,
        min_neighbors: Option<u32>,
        model_sig: Option<String>,
        effective_config_json: Option<String>,
    ) -> AsyncTask<TagResidualMetricsTask> {
        AsyncTask::new(TagResidualMetricsTask {
            db_path,
            dimensions: self.dimensions,
            max_basis: max_rank.unwrap_or(4),
            min_neighbors: min_neighbors.unwrap_or(3),
            model_sig,
            effective_config_json,
        })
    }

    /// Precompute tag-pair semantic distance (pairwise cosine similarity).
    ///
    /// - 仅对实际共现的 pair 进行计算（避免 N² 爆炸）
    /// - 单文件 Tag 数 > 100 的脏文件跳过，保持 JS 与 native 的守恒规则一致。
    /// - 增量模式：已存在且 model_sig 一致的 pair 直接跳过
    /// - sim < min_similarity 的 pair 不写入（默认丢弃噪声）
    /// - 单模型缓存策略：full_rebuild 会清空整张 sim 表，避免旧模型签名残留
    ///
    /// # 参数
    /// - `db_path`: SQLite 路径
    /// - `model_sig`: embedding 模型签名 (含维度)，跨模型自动失效
    /// - `min_similarity`: 噪声阈值，默认 0.05
    /// - `full_rebuild`: 是否清空 sim 表后重算 (默认 false 增量)
    #[napi]
    pub fn compute_tag_pair_similarities(
        &self,
        db_path: String,
        model_sig: String,
        min_similarity: Option<f64>,
        full_rebuild: Option<bool>,
    ) -> AsyncTask<TagPairSimilaritiesTask> {
        AsyncTask::new(TagPairSimilaritiesTask {
            db_path,
            dimensions: self.dimensions,
            model_sig,
            min_similarity: min_similarity.unwrap_or(0.05),
            full_rebuild: full_rebuild.unwrap_or(false),
        })
    }
}

/// 🌟 TagBasisProjection: Rust 侧 K-Means + 加权 PCA 计算结果暂存。
#[derive(Clone)]
pub struct TagBasisPendingCache {
    cache_json: String,
    cache_sig: String,
    db_identity: String,
    tag_count: u32,
    cluster_count: u32,
    basis_count: u32,
    elapsed_ms: f64,
    algorithm: String,
    phase_summary: String,
    anchor_count: u32,
    representative_sample_count: u32,
    density_bucket_count: u32,
}

/// 🌟 TagBasisProjection: Rust 侧 K-Means + 加权 PCA 计算任务。
///
/// 注意：该任务只读 SQLite 并把结果暂存在 Rust 内存，不写 kv_store；写入由 publish_tag_basis_projection_basis_cache 在短租约内完成。
pub struct TagBasisTask {
    db_path: String,
    dimensions: u32,
    cluster_count: u32,
    max_basis_dim: u32,
    pending_cache: Arc<std::sync::Mutex<Option<TagBasisPendingCache>>>,
}

fn stable_sha256_hex(value: &str) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(value.as_bytes());
    format!("{:x}", hasher.finalize())
}

fn sqlite_database_identity(db_path: &str) -> String {
    std::fs::canonicalize(db_path)
        .unwrap_or_else(|_| std::path::PathBuf::from(db_path))
        .to_string_lossy()
        .replace('\\', "/")
        .to_lowercase()
}

fn json_escape(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r")
        .replace('\t', "\\t")
}

impl Task for TagBasisTask {
    type Output = TagBasisResult;
    type JsValue = TagBasisResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use nalgebra::DMatrix;
        use std::time::Instant;

        let start = Instant::now();
        let dim = self.dimensions as usize;
        println!(
            "[Vexus-Lite][TagBasisProjection] computeTagBasis started: db={}, dim={}, cluster_count={}, max_basis_dim={}",
            self.db_path,
            dim,
            self.cluster_count,
            self.max_basis_dim
        );

        let mut tag_names = Vec::new();
        let mut tag_vectors = Vec::new();

        {
            let conn = persistence::open_sqlite_readonly(&self.db_path).map_err(|e| {
                Error::from_reason(format!("DB readonly open/config failed: {}", e))
            })?;
            let mut stmt = conn
                .prepare("SELECT name, vector FROM tags WHERE vector IS NOT NULL")
                .map_err(|e| Error::from_reason(format!("Prepare tags failed: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query tags failed: {}", e)))?;

            for row in rows {
                let (name, bytes) = row.map_err(|e| {
                    Error::from_reason(format!("Decode TagBasisProjection Tag row failed: {}", e))
                })?;
                if bytes.len() != dim * 4 {
                    continue;
                }
                let mut vector: Vec<f32> = bytes
                    .chunks_exact(4)
                    .map(|chunk| f32::from_ne_bytes(chunk.try_into().unwrap()))
                    .collect();
                tag_basis::normalize_f32_vector(&mut vector);
                tag_names.push(name);
                tag_vectors.push(vector);
            }
        }

        println!(
            "[Vexus-Lite][TagBasisProjection] loaded tag vectors: count={} elapsed={:.2}ms",
            tag_vectors.len(),
            start.elapsed().as_secs_f64() * 1000.0
        );

        let tag_count = tag_vectors.len();
        if tag_count < 8 {
            return Ok(TagBasisResult {
                success: false,
                message: "not enough tag vectors".to_string(),
                tag_count: tag_count as u32,
                cluster_count: 0,
                basis_count: 0,
                elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                algorithm: "density-residual-sampling".to_string(),
                phase_summary: "load=not_enough_vectors".to_string(),
                anchor_count: 0,
                representative_sample_count: 0,
                density_bucket_count: 0,
                publish_elapsed_ms: 0.0,
            });
        }

        let requested_anchors = std::cmp::min(tag_count, self.cluster_count as usize);
        println!(
            "[Vexus-Lite][TagBasisProjection] density-residual sampling phase started: tag_count={}, requested_anchors={}, elapsed={:.2}ms",
            tag_count,
            requested_anchors,
            start.elapsed().as_secs_f64() * 1000.0
        );
        let (
            centroids,
            weights,
            labels,
            anchor_count,
            representative_tag_count,
            density_bucket_count,
        ) = tag_basis::select_tag_basis_projection_density_residual_samples(
            &tag_vectors,
            &tag_names,
            requested_anchors,
            dim,
        );
        let k_clusters = centroids.len();
        println!(
            "[Vexus-Lite][TagBasisProjection] density-residual sampling phase finished: buckets={}, anchors={}, representative_tags={}, svd_rows={}, elapsed={:.2}ms",
            density_bucket_count,
            anchor_count,
            representative_tag_count,
            k_clusters,
            start.elapsed().as_secs_f64() * 1000.0
        );
        let total_weight: usize = weights.iter().sum();

        if total_weight == 0 {
            return Ok(TagBasisResult {
                success: false,
                message: "empty TagBasisProjection clusters".to_string(),
                tag_count: tag_count as u32,
                cluster_count: k_clusters as u32,
                basis_count: 0,
                elapsed_ms: start.elapsed().as_secs_f64() * 1000.0,
                algorithm: "density-residual-sampling".to_string(),
                phase_summary: "sampling=empty_clusters".to_string(),
                anchor_count: anchor_count as u32,
                representative_sample_count: k_clusters as u32,
                density_bucket_count: density_bucket_count as u32,
                publish_elapsed_ms: 0.0,
            });
        }

        let mut mean = vec![0.0f32; dim];
        for (idx, centroid) in centroids.iter().enumerate() {
            let weight = weights[idx] as f32;
            for d in 0..dim {
                mean[d] += centroid[d] * weight;
            }
        }
        for value in &mut mean {
            *value /= total_weight as f32;
        }

        let mut matrix_data = Vec::with_capacity(k_clusters * dim);
        for (idx, centroid) in centroids.iter().enumerate() {
            let scale = (weights[idx] as f32).sqrt();
            for d in 0..dim {
                matrix_data.push((centroid[d] - mean[d]) * scale);
            }
        }

        println!(
            "[Vexus-Lite][TagBasisProjection] SVD phase started: matrix={}x{}, elapsed={:.2}ms",
            k_clusters,
            dim,
            start.elapsed().as_secs_f64() * 1000.0
        );
        let matrix = DMatrix::from_row_slice(k_clusters, dim, &matrix_data);
        let svd = matrix.svd(false, true);
        let v_t = svd.v_t.ok_or_else(|| {
            Error::from_reason("TagBasisProjection SVD failed to compute V^T".to_string())
        })?;

        println!(
            "[Vexus-Lite][TagBasisProjection] SVD phase finished: elapsed={:.2}ms",
            start.elapsed().as_secs_f64() * 1000.0
        );

        let singular_values = svd.singular_values.as_slice();
        let max_basis = std::cmp::min(
            std::cmp::min(singular_values.len(), self.max_basis_dim as usize),
            k_clusters,
        );

        let total_energy: f64 = singular_values
            .iter()
            .take(max_basis)
            .map(|value| {
                let v = *value as f64;
                v * v
            })
            .sum();

        let mut selected_k = max_basis;
        if total_energy > 1e-12 {
            let mut cumulative = 0.0f64;
            for (idx, value) in singular_values.iter().take(max_basis).enumerate() {
                let v = *value as f64;
                cumulative += v * v;
                if cumulative / total_energy > 0.95 {
                    selected_k = std::cmp::max(idx + 1, std::cmp::min(8, max_basis));
                    break;
                }
            }
        }

        let mut basis_b64 = Vec::with_capacity(selected_k);
        let mut energies = Vec::with_capacity(selected_k);
        for i in 0..selected_k {
            let mut basis = Vec::with_capacity(dim);
            for d in 0..dim {
                basis.push(v_t[(i, d)]);
            }
            tag_basis::normalize_f32_vector(&mut basis);
            basis_b64.push(tag_basis::f32_slice_to_base64(&basis));

            let s = singular_values[i] as f64;
            energies.push(s * s);
        }

        let labels_json = labels
            .iter()
            .take(selected_k)
            .map(|label| format!("\"{}\"", json_escape(label)))
            .collect::<Vec<_>>()
            .join(",");

        let basis_json = basis_b64
            .iter()
            .map(|basis| format!("\"{}\"", basis))
            .collect::<Vec<_>>()
            .join(",");

        let energies_json = energies
            .iter()
            .map(|energy| energy.to_string())
            .collect::<Vec<_>>()
            .join(",");

        let timestamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|duration| duration.as_millis() as i64)
            .unwrap_or(0);

        let cache_json = format!(
            "{{\"basis\":[{}],\"mean\":\"{}\",\"energies\":[{}],\"labels\":[{}],\"timestamp\":{},\"tagCount\":{},\"tag_basis_projectionAlgorithm\":\"density-residual-sampling\",\"anchorCount\":{},\"representativeSampleCount\":{},\"densityBucketCount\":{},\"svdRows\":{}}}",
            basis_json,
            tag_basis::f32_slice_to_base64(&mean),
            energies_json,
            labels_json,
            timestamp,
            tag_count,
            anchor_count,
            representative_tag_count,
            density_bucket_count,
            k_clusters
        );

        let elapsed_ms = start.elapsed().as_secs_f64() * 1000.0;
        let cache_sig = stable_sha256_hex(&cache_json);
        let db_identity = sqlite_database_identity(&self.db_path);
        {
            let mut guard = self.pending_cache.lock().map_err(|e| {
                Error::from_reason(format!(
                    "TagBasisProjection pending cache lock failed: {}",
                    e
                ))
            })?;
            *guard = Some(TagBasisPendingCache {
                cache_json,
                cache_sig,
                db_identity,
                tag_count: tag_count as u32,
                cluster_count: k_clusters as u32,
                basis_count: selected_k as u32,
                elapsed_ms,
                algorithm: "density-residual-sampling".to_string(),
                phase_summary: format!(
                    "load_tags={};buckets={};representative_tags={};anchors={};svd_rows={};basis={};compute={:.2}ms",
                    tag_count,
                    density_bucket_count,
                    representative_tag_count,
                    anchor_count,
                    k_clusters,
                    selected_k,
                    elapsed_ms
                ),
                anchor_count: anchor_count as u32,
                representative_sample_count: representative_tag_count as u32,
                density_bucket_count: density_bucket_count as u32,
            });
        }

        println!(
            "[Vexus-Lite][TagBasisProjection] computeTagBasis finished and cached in Rust memory: tag_count={}, clusters={}, basis={} elapsed={:.2}ms",
            tag_count,
            k_clusters,
            selected_k,
            elapsed_ms
        );

        Ok(TagBasisResult {
            success: true,
            message: "computed_pending_publish".to_string(),
            tag_count: tag_count as u32,
            cluster_count: k_clusters as u32,
            basis_count: selected_k as u32,
            elapsed_ms,
            algorithm: "density-residual-sampling".to_string(),
            phase_summary: format!(
                "load_tags={};buckets={};representative_tags={};anchors={};svd_rows={};basis={};compute={:.2}ms",
                tag_count,
                density_bucket_count,
                representative_tag_count,
                anchor_count,
                k_clusters,
                selected_k,
                elapsed_ms
            ),
            anchor_count: anchor_count as u32,
            representative_sample_count: representative_tag_count as u32,
            density_bucket_count: density_bucket_count as u32,
            publish_elapsed_ms: 0.0,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct TagResidualMetricsTask {
    db_path: String,
    dimensions: u32,
    max_basis: u32,
    min_neighbors: u32,
    model_sig: Option<String>,
    effective_config_json: Option<String>,
}

impl Task for TagResidualMetricsTask {
    type Output = TagResidualMetricsResult;
    type JsValue = TagResidualMetricsResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::HashMap;
        use std::time::Instant;

        let start = Instant::now();
        let dim = self.dimensions as usize;
        let config_input: TagResidualConfigInput = match self.effective_config_json.as_deref() {
            Some(raw) => serde_json::from_str(raw).map_err(|e| {
                Error::from_reason(format!(
                    "Invalid tag residual metrics effective config JSON: {}",
                    e
                ))
            })?,
            None => TagResidualConfigInput::default(),
        };
        let config_source = if self.effective_config_json.is_some() {
            "js_snapshot"
        } else {
            "defaults"
        };
        let method = tag_residual_method_from_name(config_input.method.as_deref());
        let max_neighbors = config_input.max_neighbors.unwrap_or(48).clamp(4, 256);
        let max_basis = config_input
            .max_basis
            .unwrap_or(self.max_basis as usize)
            .clamp(1, 32);
        let min_neighbors = config_input
            .min_neighbors
            .unwrap_or(self.min_neighbors as usize)
            .clamp(1, 64);
        let semantic_enabled = config_input.semantic_enabled.unwrap_or(true);
        let semantic_peak = config_input.semantic_peak.unwrap_or(0.65).clamp(-1.0, 1.0);
        let semantic_sigma = config_input.semantic_sigma.unwrap_or(0.25).clamp(0.02, 2.0);
        let semantic_floor = config_input.semantic_floor.unwrap_or(0.35).clamp(0.0, 1.0);
        let semantic_hard_floor = config_input
            .semantic_hard_floor
            .unwrap_or(-1.0)
            .clamp(-1.0, 1.0);
        let min_gain = config_input.min_gain.unwrap_or(0.015).clamp(0.0, 1.0);
        let distance_decay = config_input.position_decay.unwrap_or(0.15).clamp(0.0, 4.0);
        let cfg = TagResidualConfig {
            method,
            max_neighbors,
            max_basis,
            min_neighbors,
            semantic_enabled,
            semantic_peak,
            semantic_sigma,
            semantic_floor,
            semantic_hard_floor,
            min_gain,
        };
        const TAG_RESIDUAL_ALGORITHM_VERSION: &str = "tag-residual-metrics-v1";
        let effective_config = format!(
            "{{\"algorithm\":\"{}\",\"method\":\"{}\",\"dimension\":{},\"maxNeighbors\":{},\"maxBasis\":{},\"minNeighbors\":{},\"semanticEnabled\":{},\"semanticPeak\":{},\"semanticSigma\":{},\"semanticFloor\":{},\"semanticHardFloor\":{},\"minGain\":{},\"positionDecay\":{}}}",
            TAG_RESIDUAL_ALGORITHM_VERSION,
            tag_residual_method_name(cfg.method),
            dim,
            cfg.max_neighbors,
            cfg.max_basis,
            cfg.min_neighbors,
            cfg.semantic_enabled,
            cfg.semantic_peak,
            cfg.semantic_sigma,
            cfg.semantic_floor,
            cfg.semantic_hard_floor,
            cfg.min_gain,
            distance_decay
        );
        let config_hash = stable_sha256_hex(&effective_config);

        let mut tag_vectors: HashMap<i64, Vec<f32>> = HashMap::new();
        let mut adjacency: HashMap<i64, HashMap<i64, f64>> = HashMap::new();
        let mut pairwise_similarity: HashMap<(i64, i64), f64> = HashMap::new();
        let mut skipped_files = 0usize;
        let mut edge_updates = 0usize;
        let load_started = Instant::now();
        let mut content_hasher = {
            use sha2::Digest;
            sha2::Sha256::new()
        };

        {
            let conn = persistence::open_sqlite_readonly(&self.db_path).map_err(|e| {
                Error::from_reason(format!("DB readonly open/config failed: {}", e))
            })?;
            let mut stmt = conn
                .prepare("SELECT id, vector FROM tags WHERE vector IS NOT NULL ORDER BY id")
                .map_err(|e| Error::from_reason(format!("Prepare failed: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

            for row in rows {
                let (id, bytes) = row.map_err(|e| {
                    Error::from_reason(format!("Decode tag residual row failed: {}", e))
                })?;
                {
                    use sha2::Digest;
                    content_hasher.update(id.to_le_bytes());
                    content_hasher.update((bytes.len() as u64).to_le_bytes());
                    content_hasher.update(&bytes);
                }
                if bytes.len() == dim * 4 {
                    let mut vec: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|c| f32::from_ne_bytes(c.try_into().unwrap()))
                        .collect();
                    // P0: residual 必须是单位向量相对于局部子空间的不可解释比例。
                    // 不再隐含依赖 embedding 服务已经归一化。
                    tag_basis::normalize_f32_vector(&mut vec);
                    tag_vectors.insert(id, vec);
                }
            }

            let force_recompute = std::env::var("MEMORIA_TAG_RESIDUAL_FORCE_RECOMPUTE")
                .map(|value| {
                    let normalized = value.trim().to_ascii_lowercase();
                    normalized == "true" || normalized == "1" || normalized == "yes"
                })
                .unwrap_or(false);

            if force_recompute {
                println!("[Vexus-Lite][TagResidualMetrics] force recompute enabled by MEMORIA_TAG_RESIDUAL_FORCE_RECOMPUTE.");
            }

            let adjacency_started = Instant::now();
            let mut stmt = conn.prepare(
                "SELECT file_id, tag_id, COALESCE(position, 0) FROM file_tags ORDER BY file_id, position"
            ).map_err(|e| Error::from_reason(format!("Prepare adjacency query failed: {}", e)))?;

            let rows = stmt
                .query_map([], |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .map_err(|e| {
                    Error::from_reason(format!("Execute adjacency query failed: {}", e))
                })?;

            let flush = |tags: &[(i64, i64)],
                         graph: &mut HashMap<i64, HashMap<i64, f64>>,
                         updates: &mut usize,
                         skipped: &mut usize| {
                if tags.len() < 2 {
                    return;
                }
                if tags.len() > 100 {
                    *skipped += 1;
                    return;
                }
                for i in 0..tags.len() {
                    for j in 0..tags.len() {
                        if i == j || tags[i].0 == tags[j].0 {
                            continue;
                        }
                        let delta = if tags[i].1 > 0 && tags[j].1 > 0 {
                            (tags[i].1 - tags[j].1).abs().max(1) as f64
                        } else {
                            1.0
                        };
                        let weight = if distance_decay > 0.0 {
                            (-distance_decay * (delta - 1.0)).exp()
                        } else {
                            1.0
                        };
                        let entry = graph
                            .entry(tags[i].0)
                            .or_default()
                            .entry(tags[j].0)
                            .or_insert(0.0);
                        *entry += weight;
                        *updates += 1;
                    }
                }
            };

            let mut current_file_id = -1_i64;
            let mut file_tags: Vec<(i64, i64)> = Vec::with_capacity(64);

            for row in rows {
                let (fid, tid, position) = row.map_err(|e| {
                    Error::from_reason(format!("Decode tag residual adjacency row failed: {}", e))
                })?;
                {
                    use sha2::Digest;
                    content_hasher.update(fid.to_le_bytes());
                    content_hasher.update(tid.to_le_bytes());
                    content_hasher.update(position.to_le_bytes());
                }
                if fid != current_file_id {
                    flush(
                        &file_tags,
                        &mut adjacency,
                        &mut edge_updates,
                        &mut skipped_files,
                    );
                    file_tags.clear();
                    current_file_id = fid;
                }
                file_tags.push((tid, position));
            }
            flush(
                &file_tags,
                &mut adjacency,
                &mut edge_updates,
                &mut skipped_files,
            );

            println!(
                "[Vexus-Lite][TagResidualMetrics] adjacency built: sources={}, edge_updates={}, skipped_files={}, elapsed={:.2}ms",
                adjacency.len(),
                edge_updates,
                skipped_files,
                adjacency_started.elapsed().as_secs_f64() * 1000.0
            );

            if cfg.semantic_enabled {
                if let Some(model_sig) = &self.model_sig {
                    let pair_started = Instant::now();
                    let mut stmt = conn
                        .prepare("SELECT tag_a, tag_b, similarity FROM tag_pair_similarity WHERE model_sig = ?1")
                        .map_err(|e| Error::from_reason(format!("Prepare pairwise similarity query failed: {}", e)))?;
                    let rows = stmt
                        .query_map(rusqlite::params![model_sig], |row| {
                            Ok((
                                row.get::<_, i64>(0)?,
                                row.get::<_, i64>(1)?,
                                row.get::<_, f64>(2)?,
                            ))
                        })
                        .map_err(|e| {
                            Error::from_reason(format!("Query pairwise similarity failed: {}", e))
                        })?;

                    for row in rows {
                        let (a, b, sim) = row.map_err(|e| {
                            Error::from_reason(format!(
                                "Decode pairwise similarity row failed: {}",
                                e
                            ))
                        })?;
                        pairwise_similarity.insert(pair_key(a, b), sim);
                    }
                    println!(
                        "[Vexus-Lite][TagResidualMetrics] semantic cache loaded: pairs={}, model_sig={}, elapsed={:.2}ms",
                        pairwise_similarity.len(),
                        model_sig,
                        pair_started.elapsed().as_secs_f64() * 1000.0
                    );
                } else {
                    println!("[Vexus-Lite][TagResidualMetrics] semantic gate enabled but model_sig missing; using semantic floor.");
                }
            }
        }

        let content_digest = {
            use sha2::Digest;
            format!("{:x}", content_hasher.finalize())
        };
        let graph_generation = format!(
            "content:{}:tags:{}:sources:{}:edge_updates:{}:skipped_files:{}",
            content_digest,
            tag_vectors.len(),
            adjacency.len(),
            edge_updates,
            skipped_files
        );
        let model_sig_value = self.model_sig.as_deref().unwrap_or("missing-model-sig");
        let artifact_sig = stable_sha256_hex(&format!(
            "{}|{}|{}|{}",
            model_sig_value, graph_generation, TAG_RESIDUAL_ALGORITHM_VERSION, config_hash
        ));

        let force_recompute = std::env::var("MEMORIA_TAG_RESIDUAL_FORCE_RECOMPUTE")
            .map(|value| {
                let normalized = value.trim().to_ascii_lowercase();
                normalized == "true" || normalized == "1" || normalized == "yes"
            })
            .unwrap_or(false);
        if !force_recompute && !tag_vectors.is_empty() {
            let conn = persistence::open_sqlite_readonly(&self.db_path).map_err(|e| {
                Error::from_reason(format!("DB readonly cache open/config failed: {}", e))
            })?;
            let cached_count = conn
                .query_row(
                    "SELECT COUNT(*) FROM tag_residual_metrics WHERE artifact_sig = ?1",
                    rusqlite::params![&artifact_sig],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap_or(0)
                .max(0) as usize;

            if cached_count >= tag_vectors.len() {
                let elapsed = start.elapsed().as_secs_f64() * 1000.0;
                println!(
                    "[Vexus-Lite][TagResidualMetrics] artifact cache complete; skipping recompute: artifact={}, processed={}, tags={}, elapsed={:.2}ms",
                    artifact_sig,
                    cached_count,
                    tag_vectors.len(),
                    elapsed
                );
                return Ok(TagResidualMetricsResult {
                    tag_count: tag_vectors.len() as u32,
                    computed_count: 0,
                    skipped_count: tag_vectors.len() as u32,
                    elapsed_ms: elapsed,
                    algorithm_version: TAG_RESIDUAL_ALGORITHM_VERSION.to_string(),
                    artifact_sig,
                    effective_config,
                });
            }
            println!(
                "[Vexus-Lite][TagResidualMetrics] artifact cache incomplete: artifact={}, processed={}, tags={}",
                artifact_sig,
                cached_count,
                tag_vectors.len()
            );
        }

        println!(
            "[Vexus-Lite][TagResidualMetrics] input loaded: tags={}, config_source={}, effective_config={}, artifact={}, load_elapsed={:.2}ms",
            tag_vectors.len(),
            config_source,
            effective_config,
            artifact_sig,
            load_started.elapsed().as_secs_f64() * 1000.0
        );

        let tag_count = tag_vectors.len() as u32;
        let mut computed = 0u32;
        let mut skipped = 0u32;
        let mut total_neighbors = 0usize;
        let mut results: Vec<(i64, f64, usize)> = Vec::new();
        let mut status_results: Vec<(i64, &'static str, usize, Option<String>)> =
            Vec::with_capacity(tag_vectors.len());
        let compute_started = Instant::now();

        for (&tag_id, tag_vec) in &tag_vectors {
            if (computed + skipped) > 0 && (computed + skipped) % 1000 == 0 {
                let avg_neighbors = if computed > 0 {
                    total_neighbors as f64 / computed as f64
                } else {
                    0.0
                };
                println!(
                    "[Vexus-Lite][TagResidualMetrics] progress: processed={}, computed={}, skipped={}, avg_neighbors={:.2}, elapsed={:.2}ms",
                    computed + skipped,
                    computed,
                    skipped,
                    avg_neighbors,
                    start.elapsed().as_secs_f64() * 1000.0
                );
            }

            let neighbors = match adjacency.get(&tag_id) {
                Some(value) => value,
                None => {
                    skipped += 1;
                    status_results.push((tag_id, "insufficient_neighbors", 0, None));
                    continue;
                }
            };

            let mut candidates = Vec::with_capacity(neighbors.len().min(cfg.max_neighbors));
            for (&nid, &weight) in neighbors {
                if !tag_vectors.contains_key(&nid) {
                    continue;
                }
                let sim = pairwise_similarity
                    .get(&pair_key(tag_id, nid))
                    .copied()
                    .unwrap_or(0.0);
                let semantic = semantic_gate(sim, &cfg);
                if semantic <= 0.0 {
                    continue;
                }
                candidates.push(TagResidualNeighbor {
                    id: nid,
                    weight,
                    semantic,
                });
            }

            candidates.sort_by(|a, b| {
                let sa = a.weight * a.semantic;
                let sb = b.weight * b.semantic;
                sb.partial_cmp(&sa).unwrap_or(std::cmp::Ordering::Equal)
            });
            if candidates.len() > cfg.max_neighbors {
                candidates.truncate(cfg.max_neighbors);
            }

            if candidates.len() < cfg.min_neighbors {
                skipped += 1;
                status_results.push((tag_id, "insufficient_neighbors", candidates.len(), None));
                continue;
            }

            let residual_energy = match cfg.method {
                TagResidualMethod::AnchoredGs => {
                    compute_anchored_gs_residual(tag_vec, &candidates, &tag_vectors, dim, &cfg)
                }
                TagResidualMethod::Centroid => {
                    compute_centroid_residual(tag_vec, &candidates, &tag_vectors, dim)
                }
                TagResidualMethod::Svd => {
                    compute_svd_residual(tag_vec, &candidates, &tag_vectors, dim, cfg.max_basis)
                }
            };

            if let Some(value) = residual_energy {
                total_neighbors += candidates.len();
                // 输入已单位化且基底正交，理论范围为 [0,1]；夹逼仅吸收浮点误差。
                let residual_ratio = value.clamp(0.0, 1.0);
                results.push((tag_id, residual_ratio, candidates.len()));
                status_results.push((tag_id, "computed", candidates.len(), None));
                computed += 1;
            } else {
                skipped += 1;
                status_results.push((
                    tag_id,
                    "failed",
                    candidates.len(),
                    Some("residual method produced no usable basis".to_string()),
                ));
            }
        }

        println!(
            "[Vexus-Lite][TagResidualMetrics] compute phase finished: computed={}, skipped={}, avg_neighbors={:.2}, elapsed={:.2}ms",
            computed,
            skipped,
            if computed > 0 { total_neighbors as f64 / computed as f64 } else { 0.0 },
            compute_started.elapsed().as_secs_f64() * 1000.0
        );

        if !status_results.is_empty() {
            let write_started = Instant::now();
            let max_r = results.iter().map(|r| r.1).fold(0.0f64, f64::max);
            let min_r = results.iter().map(|r| r.1).fold(f64::MAX, f64::min);

            let computed_at = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|duration| duration.as_millis() as i64)
                .unwrap_or(0);

            let mut conn = persistence::open_sqlite_readwrite(&self.db_path)
                .map_err(|e| Error::from_reason(format!("DB write open/config failed: {}", e)))?;
            let tx = conn
                .transaction()
                .map_err(|e| Error::from_reason(format!("Transaction failed: {}", e)))?;

            tx.execute("DELETE FROM tag_residual_metrics", [])
                .map_err(|e| Error::from_reason(format!("Residual metrics clear failed: {}", e)))?;

            tx.execute(
                "INSERT OR REPLACE INTO tag_derived_artifacts \
                 (artifact_sig, artifact_type, model_sig, graph_generation, algorithm_version, config_hash, effective_config, status, created_at, updated_at) \
                 VALUES (?1, 'tag_residual_metrics', ?2, ?3, ?4, ?5, ?6, 'ready', ?7, ?7)",
                rusqlite::params![
                    &artifact_sig,
                    model_sig_value,
                    &graph_generation,
                    TAG_RESIDUAL_ALGORITHM_VERSION,
                    &config_hash,
                    &effective_config,
                    computed_at
                ],
            )
            .map_err(|e| Error::from_reason(format!("Residual artifact registration failed: {}", e)))?;

            {
                let mut insert_metrics = tx
                    .prepare(
                        "INSERT OR REPLACE INTO tag_residual_metrics \
                     (tag_id, residual_energy, neighbor_count, residual_ratio, model_sig, artifact_sig, algorithm_version, config_hash, status, computed_at) \
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                    )
                    .map_err(|e| {
                        Error::from_reason(format!("Prepare residual metrics insert failed: {}", e))
                    })?;

                for (tag_id, status, neighbor_count, error_message) in &status_results {
                    let (residual_energy, residual_ratio) = results
                        .iter()
                        .find(|(result_id, _, _)| result_id == tag_id)
                        .map(|(_, value, _)| (*value, *value))
                        .unwrap_or((0.0, 0.0));
                    let status = if error_message.is_some() {
                        "failed"
                    } else {
                        *status
                    };
                    insert_metrics
                        .execute(rusqlite::params![
                            tag_id,
                            residual_energy,
                            *neighbor_count as i64,
                            residual_ratio,
                            model_sig_value,
                            &artifact_sig,
                            TAG_RESIDUAL_ALGORITHM_VERSION,
                            &config_hash,
                            status,
                            computed_at,
                        ])
                        .map_err(|e| {
                            Error::from_reason(format!("Residual metrics insert failed: {}", e))
                        })?;
                }
            }

            tx.commit()
                .map_err(|e| Error::from_reason(format!("Commit failed: {}", e)))?;

            println!(
                "[Vexus-Lite][TagResidualMetrics] canonical single-track write finished: values={}, statuses={}, artifact={}, raw_min={:.6}, raw_max={:.6}, elapsed={:.2}ms",
                results.len(),
                status_results.len(),
                artifact_sig,
                if results.is_empty() { 0.0 } else { min_r },
                max_r,
                write_started.elapsed().as_secs_f64() * 1000.0
            );
        }

        let elapsed = start.elapsed().as_secs_f64() * 1000.0;

        Ok(TagResidualMetricsResult {
            tag_count,
            computed_count: computed,
            skipped_count: skipped,
            elapsed_ms: elapsed,
            algorithm_version: TAG_RESIDUAL_ALGORITHM_VERSION.to_string(),
            artifact_sig,
            effective_config,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

/// Native task for canonical tag-pair similarities.
/// 预计算实际共现的 Tag 对的余弦相似度，并写入 tag_pair_similarity。
pub struct TagPairSimilaritiesTask {
    db_path: String,
    dimensions: u32,
    model_sig: String,
    min_similarity: f64,
    full_rebuild: bool,
}

impl Task for TagPairSimilaritiesTask {
    type Output = TagPairSimilarityResult;
    type JsValue = TagPairSimilarityResult;

    fn compute(&mut self) -> Result<Self::Output> {
        use std::collections::{HashMap, HashSet};
        use std::time::Instant;

        let start = Instant::now();
        let dim = self.dimensions as usize;
        const PAIRWISE_ALGORITHM_VERSION: &str = "pairwise_cosine_v1";

        // ====================================================================
        // Step 1-3: 只读加载 Tag 向量、共现 pair 与缓存集合
        // ====================================================================
        let mut tag_vectors: HashMap<i64, Vec<f32>> = HashMap::new();
        let mut pair_set: HashSet<(i64, i64)> = HashSet::new();
        let mut cached: HashSet<(i64, i64)> = HashSet::new();
        let mut max_tag_id = 0_i64;
        let mut file_tag_rows = 0_u64;
        let (pair_count, graph_generation) = {
            let conn = persistence::open_sqlite_readonly(&self.db_path).map_err(|e| {
                Error::from_reason(format!("DB readonly open/config failed: {}", e))
            })?;
            let mut content_hasher = {
                use sha2::Digest;
                sha2::Sha256::new()
            };
            let mut stmt = conn
                .prepare("SELECT id, vector FROM tags WHERE vector IS NOT NULL ORDER BY id")
                .map_err(|e| Error::from_reason(format!("Prepare tags query failed: {}", e)))?;
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query tags failed: {}", e)))?;

            for row in rows {
                let (id, bytes) = row.map_err(|e| {
                    Error::from_reason(format!("Decode pairwise Tag row failed: {}", e))
                })?;
                max_tag_id = max_tag_id.max(id);
                {
                    use sha2::Digest;
                    content_hasher.update(id.to_le_bytes());
                    content_hasher.update((bytes.len() as u64).to_le_bytes());
                    content_hasher.update(&bytes);
                }
                if bytes.len() == dim * 4 {
                    let vec: Vec<f32> = bytes
                        .chunks_exact(4)
                        .map(|c| f32::from_ne_bytes(c.try_into().unwrap()))
                        .collect();
                    tag_vectors.insert(id, vec);
                }
            }

            // ====================================================================
            // Step 2: 在 Rust 侧聚合 file_tags，构建实际共现的 (tag_a, tag_b) 集合
            // 单文件 Tag 数 > 100 的脏文件跳过，保持 JS 与 native 的守恒规则一致。
            // 约定 tag_a < tag_b
            // ====================================================================
            let mut stmt = conn
                .prepare("SELECT file_id, tag_id FROM file_tags ORDER BY file_id, tag_id")
                .map_err(|e| {
                    Error::from_reason(format!("Prepare file_tags query failed: {}", e))
                })?;

            let rows = stmt
                .query_map([], |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)))
                .map_err(|e| Error::from_reason(format!("Query file_tags failed: {}", e)))?;

            let mut current_file_id = -1_i64;
            let mut file_tags: Vec<i64> = Vec::with_capacity(64);

            let flush = |tags: &Vec<i64>, set: &mut HashSet<(i64, i64)>| {
                if tags.len() < 2 || tags.len() > 100 {
                    return;
                }
                for i in 0..tags.len() {
                    for j in (i + 1)..tags.len() {
                        let a = tags[i];
                        let b = tags[j];
                        if a == b {
                            continue;
                        }
                        let pair = if a < b { (a, b) } else { (b, a) };
                        set.insert(pair);
                    }
                }
            };

            for row in rows {
                let (fid, tid) = row.map_err(|e| {
                    Error::from_reason(format!("Decode pairwise file_tags row failed: {}", e))
                })?;
                file_tag_rows += 1;
                max_tag_id = max_tag_id.max(tid);
                {
                    use sha2::Digest;
                    content_hasher.update(fid.to_le_bytes());
                    content_hasher.update(tid.to_le_bytes());
                }
                if fid != current_file_id {
                    flush(&file_tags, &mut pair_set);
                    file_tags.clear();
                    current_file_id = fid;
                }
                file_tags.push(tid);
            }
            flush(&file_tags, &mut pair_set);

            let content_digest = {
                use sha2::Digest;
                format!("{:x}", content_hasher.finalize())
            };
            let pair_count = pair_set.len() as u32;
            let graph_generation = format!(
                "content:{}:tags:{}:max_tag:{}:file_tag_rows:{}:pairs:{}",
                content_digest,
                tag_vectors.len(),
                max_tag_id,
                file_tag_rows,
                pair_count
            );
            (pair_count, graph_generation)
        };

        let effective_config = format!(
            "{{\"algorithm\":\"{}\",\"dimension\":{},\"minSimilarity\":{},\"modelSig\":\"{}\"}}",
            PAIRWISE_ALGORITHM_VERSION,
            dim,
            self.min_similarity,
            json_escape(&self.model_sig)
        );
        let config_hash = stable_sha256_hex(&effective_config);
        let artifact_sig = stable_sha256_hex(&format!(
            "{}|{}|{}|{}",
            self.model_sig, graph_generation, PAIRWISE_ALGORITHM_VERSION, config_hash
        ));

        // ====================================================================
        // Step 3: 增量模式 — 加载当前 artifact 已处理的正/负 pair 集合
        // full_rebuild = true 时才按显式重建语义清空整张旧表。
        //
        // 注意：非 full_rebuild 冷启动不能在 Rust 侧主动删除旧 model_sig。
        // 部分用户可能处于“签名变化 / tag 索引尚未恢复 / 空库初始化”窗口；
        // 如果此时先 DELETE 旧模型行，而本轮 pair_set 又为 0，就会造成旧缓存被清空且新缓存未生成。
        // 旧模型行的安全清理交给 JS 侧在确认当前 model_sig 已有可用缓存后执行。
        // ====================================================================
        if !self.full_rebuild {
            let conn = persistence::open_sqlite_readonly(&self.db_path).map_err(|e| {
                Error::from_reason(format!("DB readonly open/config failed: {}", e))
            })?;
            let mut stmt = conn
                .prepare(
                    "SELECT tag_a, tag_b FROM tag_pair_similarity_status \
                     WHERE artifact_sig = ?1 AND status IN ('computed', 'below_threshold', 'missing_vector')",
                )
                .map_err(|e| Error::from_reason(format!("Prepare pairwise status cache query failed: {}", e)))?;
            let rows = stmt
                .query_map(rusqlite::params![&artifact_sig], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?))
                })
                .map_err(|e| {
                    Error::from_reason(format!("Query pairwise status cache failed: {}", e))
                })?;

            for row in rows {
                let (a, b) = row.map_err(|e| {
                    Error::from_reason(format!("Decode pairwise status cache row failed: {}", e))
                })?;
                cached.insert(pair_key(a, b));
            }
        }

        println!(
            "[Vexus-Lite][Pairwise] artifact={} graph_generation={} cached_statuses={}",
            artifact_sig,
            graph_generation,
            cached.len()
        );

        // ====================================================================
        // Step 4: 遍历待计算 pair，计算余弦相似度
        // 假设 tag 向量已归一化（embedding 模型默认输出归一化向量），
        // 若未归一化，下方会按需 fallback 到带分母的余弦
        // ====================================================================
        let mut to_insert: Vec<(i64, i64, f64, i64)> = Vec::new();
        let mut status_rows: Vec<(i64, i64, &'static str, Option<f64>, i64)> = Vec::new();
        let mut computed = 0_u32;
        let mut skipped = 0_u32;
        let now_ms = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_millis() as i64)
            .unwrap_or(0);

        for &(a, b) in pair_set.iter() {
            if cached.contains(&(a, b)) {
                skipped += 1;
                continue;
            }

            let va = match tag_vectors.get(&a) {
                Some(v) => v,
                None => {
                    skipped += 1;
                    status_rows.push((a, b, "missing_vector", None, now_ms));
                    continue;
                }
            };
            let vb = match tag_vectors.get(&b) {
                Some(v) => v,
                None => {
                    skipped += 1;
                    status_rows.push((a, b, "missing_vector", None, now_ms));
                    continue;
                }
            };

            let sim = cosine_similarity(va, vb, dim);

            computed += 1;

            if sim < self.min_similarity {
                // 数值不写旧正值表，但写入状态表形成真正的增量负缓存。
                skipped += 1;
                status_rows.push((a, b, "below_threshold", Some(sim), now_ms));
                continue;
            }

            to_insert.push((a, b, sim, now_ms));
            status_rows.push((a, b, "computed", Some(sim), now_ms));
        }

        // ====================================================================
        // Step 5: 流式分包写入
        // ====================================================================
        let stored_count = to_insert.len() as u32;
        if !status_rows.is_empty() || self.full_rebuild {
            let mut conn = persistence::open_sqlite_readwrite(&self.db_path)
                .map_err(|e| Error::from_reason(format!("DB write open/config failed: {}", e)))?;
            let tx = conn.transaction().map_err(|e| {
                Error::from_reason(format!("Begin atomic pairwise publish failed: {}", e))
            })?;

            if self.full_rebuild {
                tx.execute("DELETE FROM tag_pair_similarity", [])
                    .map_err(|e| {
                        Error::from_reason(format!(
                            "Full rebuild positive cache clear failed: {}",
                            e
                        ))
                    })?;
                tx.execute("DELETE FROM tag_pair_similarity_status", [])
                    .map_err(|e| {
                        Error::from_reason(format!("Full rebuild status cache clear failed: {}", e))
                    })?;
            }

            let artifact_now = now_ms;
            tx.execute(
        "INSERT OR REPLACE INTO tag_derived_artifacts \
         (artifact_sig, artifact_type, model_sig, graph_generation, algorithm_version, config_hash, effective_config, status, created_at, updated_at) \
         VALUES (?1, 'tag_pair_similarity', ?2, ?3, ?4, ?5, ?6, 'building', ?7, ?7)",
        rusqlite::params![
            &artifact_sig,
            &self.model_sig,
            &graph_generation,
            PAIRWISE_ALGORITHM_VERSION,
            &config_hash,
            &effective_config,
            artifact_now
        ],
    )
    .map_err(|e| {
        Error::from_reason(format!("Pairwise building registration failed: {}", e))
    })?;

            {
                let mut stmt = tx
                    .prepare(
                        "INSERT OR REPLACE INTO tag_pair_similarity \
                 (tag_a, tag_b, similarity, model_sig, computed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                    )
                    .map_err(|e| {
                        Error::from_reason(format!("Prepare pairwise value insert failed: {}", e))
                    })?;
                for (a, b, sim, ts) in &to_insert {
                    stmt.execute(rusqlite::params![a, b, sim, &self.model_sig, ts])
                        .map_err(|e| {
                            Error::from_reason(format!(
                                "Insert pairwise value ({}, {}) failed: {}",
                                a, b, e
                            ))
                        })?;
                }
            }

            {
                let mut stmt = tx
            .prepare(
                "INSERT OR REPLACE INTO tag_pair_similarity_status \
                 (tag_a, tag_b, model_sig, artifact_sig, status, similarity, min_similarity, computed_at) \
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            )
            .map_err(|e| {
                Error::from_reason(format!("Prepare pairwise status insert failed: {}", e))
            })?;
                for (a, b, status, similarity, ts) in &status_rows {
                    stmt.execute(rusqlite::params![
                        a,
                        b,
                        &self.model_sig,
                        &artifact_sig,
                        status,
                        similarity,
                        self.min_similarity,
                        ts
                    ])
                    .map_err(|e| {
                        Error::from_reason(format!(
                            "Insert pairwise status ({}, {}) failed: {}",
                            a, b, e
                        ))
                    })?;
                }
            }

            tx.execute(
                "UPDATE tag_derived_artifacts SET status = 'ready', updated_at = ?2 \
         WHERE artifact_sig = ?1",
                rusqlite::params![&artifact_sig, artifact_now],
            )
            .map_err(|e| Error::from_reason(format!("Pairwise ready transition failed: {}", e)))?;

            tx.commit().map_err(|e| {
                Error::from_reason(format!("Commit atomic pairwise publish failed: {}", e))
            })?;

            // 最终 TRUNCATE checkpoint 仍由 JS coordinator 统一执行。
        }

        let elapsed = start.elapsed().as_secs_f64() * 1000.0;

        Ok(TagPairSimilarityResult {
            pair_count,
            computed_count: computed,
            skipped_count: skipped,
            stored_count,
            elapsed_ms: elapsed,
        })
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}

pub struct RecoverTask {
    index: Arc<RwLock<Index>>,
    db_path: String,
    table_type: String,
    filter_space: Option<String>,
    dimensions: u32,
}

impl Task for RecoverTask {
    type Output = u32;
    type JsValue = u32;

    fn compute(&mut self) -> Result<Self::Output> {
        let conn = persistence::open_sqlite_readonly(&self.db_path)
            .map_err(|e| Error::from_reason(format!("Failed to open/config DB readonly: {}", e)))?;

        let sql: String;

        if self.table_type == "tags" {
            sql = "SELECT id, vector FROM tags WHERE vector IS NOT NULL".to_string();
        } else if self.table_type == "chunks" && self.filter_space.is_some() {
            sql = "SELECT c.id, c.vector FROM chunks c JOIN files f ON c.file_id = f.id WHERE f.space = ?1 AND c.vector IS NOT NULL".to_string();
        } else {
            return Ok(0);
        }

        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::from_reason(format!("Failed to prepare statement: {}", e)))?;

        // 参数在下面的 query_map 调用中直接处理，这里不再需要准备 params 变量

        // 为了避免复杂的生命周期问题，我们简单地分别处理
        let mut count = 0;
        let mut skipped_dim_mismatch = 0;
        let expected_byte_len = self.dimensions as usize * std::mem::size_of::<f32>();

        // 获取写锁
        let index = self
            .index
            .write()
            .map_err(|e| Error::from_reason(format!("Lock failed: {}", e)))?;

        // 维度不匹配仍按兼容契约跳过；索引内部失败必须显式返回，
        // 避免调用方把部分恢复误认为完整成功。
        let mut process_row = |id: i64, vector_bytes: Vec<u8>| -> Result<()> {
            if vector_bytes.len() == expected_byte_len {
                let vec_slice: Vec<f32> = vector_bytes
                    .chunks_exact(4)
                    .map(|c| f32::from_ne_bytes(c.try_into().unwrap()))
                    .collect();

                if index.size() + 1 >= index.capacity() {
                    let new_cap = (index.capacity() as f64 * 1.5) as usize;
                    index.reserve(new_cap).map_err(|e| {
                        Error::from_reason(format!(
                            "Recover reserve failed before vector {}: {:?}",
                            id, e
                        ))
                    })?;
                }

                index.add(id as u64, &vec_slice).map_err(|e| {
                    Error::from_reason(format!("Recover add failed for vector {}: {:?}", id, e))
                })?;
                count += 1;
            } else {
                skipped_dim_mismatch += 1;
            }
            Ok(())
        };

        if let Some(name) = &self.filter_space {
            let rows = stmt
                .query_map([name], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

            for row_result in rows {
                let (id, vector_bytes) = row_result.map_err(|e| {
                    Error::from_reason(format!("Decode recovery row failed: {}", e))
                })?;
                process_row(id, vector_bytes)?;
            }
        } else {
            let rows = stmt
                .query_map([], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, Vec<u8>>(1)?))
                })
                .map_err(|e| Error::from_reason(format!("Query failed: {}", e)))?;

            for row_result in rows {
                let (id, vector_bytes) = row_result.map_err(|e| {
                    Error::from_reason(format!("Decode recovery row failed: {}", e))
                })?;
                process_row(id, vector_bytes)?;
            }
        }

        if skipped_dim_mismatch > 0 {
            // 这里使用 println!，它会输出到 Node.js 的 stdout
            println!("[Vexus-Lite] ⚠️ Skipped {} vectors due to dimension mismatch (Expected {} bytes, got various)", skipped_dim_mismatch, expected_byte_len);
        }

        Ok(count)
    }

    fn resolve(&mut self, _env: Env, output: Self::Output) -> Result<Self::JsValue> {
        Ok(output)
    }
}
