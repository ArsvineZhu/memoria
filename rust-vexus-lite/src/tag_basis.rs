pub(crate) fn f32_slice_to_base64(values: &[f32]) -> String {
    use base64::Engine;
    let mut bytes = Vec::with_capacity(std::mem::size_of_val(values));
    for value in values {
        bytes.extend_from_slice(&value.to_ne_bytes());
    }
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

pub(crate) fn normalize_f32_vector(vector: &mut [f32]) {
    let mut mag = 0.0f64;
    for value in vector.iter() {
        mag += (*value as f64) * (*value as f64);
    }
    let mag = mag.sqrt();
    if mag > 1e-9 {
        for value in vector.iter_mut() {
            *value = (*value as f64 / mag) as f32;
        }
    }
}

struct TagBasisDensityBucket {
    count: usize,
    sum: Vec<f32>,
    best_idx: usize,
    best_residual: f64,
    samples: Vec<(usize, f64)>,
}

struct TagBasisAnchorCandidate {
    key: u16,
    density: usize,
    centroid: Vec<f32>,
    label_idx: usize,
    base_score: f64,
}

fn tag_basis_projection_projection_bit(
    vector: &[f32],
    mean: &[f32],
    bit: usize,
    dim: usize,
) -> bool {
    let mut acc = 0.0f64;
    let mut state = (bit as u64 + 1).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    for _ in 0..16 {
        state ^= state >> 12;
        state ^= state << 25;
        state ^= state >> 27;
        let idx = (state as usize) % dim;
        let sign = if (state & 0x8000_0000_0000_0000) == 0 {
            1.0
        } else {
            -1.0
        };
        acc += ((vector[idx] - mean[idx]) as f64) * sign;
    }
    acc >= 0.0
}

fn tag_basis_projection_density_key(vector: &[f32], mean: &[f32], dim: usize) -> u16 {
    let mut key = 0u16;
    for bit in 0..12 {
        if tag_basis_projection_projection_bit(vector, mean, bit, dim) {
            key |= 1u16 << bit;
        }
    }
    key
}

fn tag_basis_projection_residual_norm(vector: &[f32], mean: &[f32], dim: usize) -> f64 {
    let mut norm = 0.0f64;
    for d in 0..dim {
        let v = (vector[d] - mean[d]) as f64;
        norm += v * v;
    }
    norm.sqrt()
}

pub(crate) fn select_tag_basis_projection_density_residual_samples(
    vectors: &[Vec<f32>],
    names: &[String],
    requested_anchors: usize,
    dim: usize,
) -> (Vec<Vec<f32>>, Vec<usize>, Vec<String>, usize, usize, usize) {
    use std::collections::{HashMap, HashSet};

    let started_at = std::time::Instant::now();
    let tag_count = vectors.len();
    let anchor_count = requested_anchors.clamp(8, 128).min(tag_count);
    let samples_per_anchor = std::env::var("TagBasisProjection_RUST_SAMPLES_PER_ANCHOR")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(32)
        .clamp(4, 128);

    println!(
        "[Vexus-Lite][TagBasisProjection] density-residual sampling started: tags={}, anchors={}, samples_per_anchor={}, dim={}",
        tag_count,
        anchor_count,
        samples_per_anchor,
        dim
    );

    let mut mean = vec![0.0f32; dim];
    for vector in vectors {
        for d in 0..dim {
            mean[d] += vector[d];
        }
    }
    for value in &mut mean {
        *value /= tag_count as f32;
    }

    let mut buckets: HashMap<u16, TagBasisDensityBucket> = HashMap::new();
    for (idx, vector) in vectors.iter().enumerate() {
        let key = tag_basis_projection_density_key(vector, &mean, dim);
        let residual = tag_basis_projection_residual_norm(vector, &mean, dim);
        let bucket = buckets.entry(key).or_insert_with(|| TagBasisDensityBucket {
            count: 0,
            sum: vec![0.0f32; dim],
            best_idx: idx,
            best_residual: residual,
            samples: Vec::with_capacity(samples_per_anchor),
        });

        bucket.count += 1;
        for d in 0..dim {
            bucket.sum[d] += vector[d];
        }

        if residual > bucket.best_residual {
            bucket.best_residual = residual;
            bucket.best_idx = idx;
        }

        let insert_at = bucket
            .samples
            .binary_search_by(|probe| {
                probe
                    .1
                    .partial_cmp(&residual)
                    .unwrap_or(std::cmp::Ordering::Equal)
                    .reverse()
            })
            .unwrap_or_else(|pos| pos);
        if insert_at < samples_per_anchor {
            bucket.samples.insert(insert_at, (idx, residual));
            if bucket.samples.len() > samples_per_anchor {
                bucket.samples.pop();
            }
        } else if bucket.samples.len() < samples_per_anchor {
            bucket.samples.push((idx, residual));
        }
    }

    println!(
        "[Vexus-Lite][TagBasisProjection] density buckets built: buckets={}, elapsed={:.2}ms",
        buckets.len(),
        started_at.elapsed().as_secs_f64() * 1000.0
    );

    let mut candidates = Vec::with_capacity(buckets.len());
    for (key, bucket) in &buckets {
        if bucket.count == 0 {
            continue;
        }

        let mut centroid = bucket.sum.clone();
        for value in &mut centroid {
            *value /= bucket.count as f32;
        }
        normalize_f32_vector(&mut centroid);

        let density = bucket.count as f64;
        let residual = bucket.best_residual.max(1e-9);
        let base_score = density.powf(0.65) * residual.powf(0.35);

        candidates.push(TagBasisAnchorCandidate {
            key: *key,
            density: bucket.count,
            centroid,
            label_idx: bucket.best_idx,
            base_score,
        });
    }

    candidates.sort_by(|a, b| {
        b.base_score
            .partial_cmp(&a.base_score)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let candidate_limit = std::env::var("TagBasisProjection_RUST_ANCHOR_CANDIDATE_LIMIT")
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(512)
        .clamp(anchor_count, 4096);
    candidates.truncate(candidate_limit);

    let mut centered_centroids: Vec<Vec<f64>> = Vec::with_capacity(candidates.len());
    for candidate in &candidates {
        let mut centered = Vec::with_capacity(dim);
        let mut norm_sq = 0.0f64;
        for d in 0..dim {
            let value = (candidate.centroid[d] - mean[d]) as f64;
            norm_sq += value * value;
            centered.push(value);
        }
        let norm = norm_sq.sqrt();
        if norm > 1e-12 {
            for value in &mut centered {
                *value /= norm;
            }
        }
        centered_centroids.push(centered);
    }

    let mut selected: Vec<TagBasisAnchorCandidate> = Vec::with_capacity(anchor_count);
    let mut selected_centered: Vec<Vec<f64>> = Vec::with_capacity(anchor_count);
    let mut candidate_max_sim = vec![0.0f64; candidates.len()];

    while selected.len() < anchor_count && !candidates.is_empty() {
        let mut best_idx = 0usize;
        let mut best_score = f64::MIN;

        for (idx, candidate) in candidates.iter().enumerate() {
            let max_sim = candidate_max_sim[idx];
            let diversity_decay = (-3.0 * max_sim * max_sim).exp();
            let score = candidate.base_score * diversity_decay;
            if score > best_score {
                best_score = score;
                best_idx = idx;
            }
        }

        let chosen = candidates.swap_remove(best_idx);
        let chosen_centered = centered_centroids.swap_remove(best_idx);
        candidate_max_sim.swap_remove(best_idx);

        for (idx, centered) in centered_centroids.iter().enumerate() {
            let mut sim = 0.0f64;
            for d in 0..dim {
                sim += centered[d] * chosen_centered[d];
            }
            let sim = sim.max(0.0);
            if sim > candidate_max_sim[idx] {
                candidate_max_sim[idx] = sim;
            }
        }

        selected_centered.push(chosen_centered);
        selected.push(chosen);
    }

    let mut representative_tag_indices = HashSet::new();
    let mut anchor_vectors = Vec::with_capacity(selected.len());
    let mut weights = Vec::with_capacity(selected.len());
    let mut labels = Vec::with_capacity(selected.len());

    for anchor in &selected {
        labels.push(
            names
                .get(anchor.label_idx)
                .cloned()
                .unwrap_or_else(|| "Unknown".to_string()),
        );
        anchor_vectors.push(anchor.centroid.clone());
        weights.push(anchor.density.max(1));

        if let Some(bucket) = buckets.get(&anchor.key) {
            for (idx, _residual) in &bucket.samples {
                representative_tag_indices.insert(*idx);
            }
        }
        representative_tag_indices.insert(anchor.label_idx);
    }

    println!(
        "[Vexus-Lite][TagBasisProjection] density-residual sampling finished: anchors={}, representative_tags={}, svd_rows={}, elapsed={:.2}ms",
        selected.len(),
        representative_tag_indices.len(),
        anchor_vectors.len(),
        started_at.elapsed().as_secs_f64() * 1000.0
    );

    (
        anchor_vectors,
        weights,
        labels,
        selected.len(),
        representative_tag_indices.len(),
        buckets.len(),
    )
}

#[cfg(test)]
mod tests {
    use super::normalize_f32_vector;

    #[test]
    fn normalization_keeps_direction_and_unit_length() {
        let mut vector = vec![3.0_f32, 4.0_f32];
        normalize_f32_vector(&mut vector);
        assert!((vector[0] - 0.6).abs() < 1e-6);
        assert!((vector[1] - 0.8).abs() < 1e-6);
    }
}
