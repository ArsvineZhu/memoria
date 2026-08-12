#[derive(Clone, Copy)]
pub(crate) enum TagResidualMethod {
    AnchoredGs,
    Centroid,
    Svd,
}

#[derive(Clone)]
pub(crate) struct TagResidualNeighbor {
    pub(crate) id: i64,
    pub(crate) weight: f64,
    pub(crate) semantic: f64,
}

pub(crate) struct TagResidualConfig {
    pub(crate) method: TagResidualMethod,
    pub(crate) max_neighbors: usize,
    pub(crate) max_basis: usize,
    pub(crate) min_neighbors: usize,
    pub(crate) semantic_enabled: bool,
    pub(crate) semantic_peak: f64,
    pub(crate) semantic_sigma: f64,
    pub(crate) semantic_floor: f64,
    pub(crate) semantic_hard_floor: f64,
    pub(crate) min_gain: f64,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub(crate) struct TagResidualConfigInput {
    pub(crate) method: Option<String>,
    pub(crate) max_neighbors: Option<usize>,
    pub(crate) max_basis: Option<usize>,
    pub(crate) min_neighbors: Option<usize>,
    pub(crate) semantic_enabled: Option<bool>,
    pub(crate) semantic_peak: Option<f64>,
    pub(crate) semantic_sigma: Option<f64>,
    pub(crate) semantic_floor: Option<f64>,
    pub(crate) semantic_hard_floor: Option<f64>,
    pub(crate) min_gain: Option<f64>,
    pub(crate) position_decay: Option<f64>,
}

pub(crate) fn tag_residual_method_from_name(value: Option<&str>) -> TagResidualMethod {
    match value
        .unwrap_or("anchored_gs")
        .trim()
        .to_ascii_lowercase()
        .as_str()
    {
        "centroid" => TagResidualMethod::Centroid,
        "svd" => TagResidualMethod::Svd,
        _ => TagResidualMethod::AnchoredGs,
    }
}

pub(crate) fn tag_residual_method_name(method: TagResidualMethod) -> &'static str {
    match method {
        TagResidualMethod::AnchoredGs => "anchored_gs",
        TagResidualMethod::Centroid => "centroid",
        TagResidualMethod::Svd => "svd",
    }
}

fn dot_f32_f64(a: &[f32], b: &[f64], dim: usize) -> f64 {
    let mut dot = 0.0;
    for d in 0..dim {
        dot += (a[d] as f64) * b[d];
    }
    dot
}

fn dot_f64(a: &[f64], b: &[f64], dim: usize) -> f64 {
    let mut dot = 0.0;
    for d in 0..dim {
        dot += a[d] * b[d];
    }
    dot
}

fn residual_norm_from_basis(tag_vec: &[f32], basis: &[Vec<f64>], dim: usize) -> f64 {
    let coeffs = basis
        .iter()
        .map(|u| dot_f32_f64(tag_vec, u, dim))
        .collect::<Vec<_>>();

    let mut residual_sq = 0.0;
    for d in 0..dim {
        let mut projection = 0.0;
        for (coeff, u) in coeffs.iter().zip(basis.iter()) {
            projection += coeff * u[d];
        }
        let diff = (tag_vec[d] as f64) - projection;
        residual_sq += diff * diff;
    }
    residual_sq.sqrt()
}

pub(crate) fn semantic_gate(sim: f64, cfg: &TagResidualConfig) -> f64 {
    if !cfg.semantic_enabled {
        return 1.0;
    }
    if !sim.is_finite() || sim <= 0.0 {
        return cfg.semantic_floor;
    }
    if sim < cfg.semantic_hard_floor {
        return 0.0;
    }
    let bell = 0.5
        + 0.8
            * (-((sim - cfg.semantic_peak).powi(2))
                / (2.0 * cfg.semantic_sigma * cfg.semantic_sigma))
                .exp();
    bell.max(cfg.semantic_floor)
}

pub(crate) fn pair_key(a: i64, b: i64) -> (i64, i64) {
    if a < b {
        (a, b)
    } else {
        (b, a)
    }
}

pub(crate) fn compute_centroid_residual(
    tag_vec: &[f32],
    neighbors: &[TagResidualNeighbor],
    tag_vectors: &std::collections::HashMap<i64, Vec<f32>>,
    dim: usize,
) -> Option<f64> {
    let mut centroid = vec![0.0f64; dim];
    let mut total_weight = 0.0;
    for neighbor in neighbors {
        let vec = tag_vectors.get(&neighbor.id)?;
        let weight = neighbor.weight * neighbor.semantic;
        if weight <= 0.0 {
            continue;
        }
        total_weight += weight;
        for d in 0..dim {
            centroid[d] += (vec[d] as f64) * weight;
        }
    }
    if total_weight <= 1e-12 {
        return None;
    }
    for value in &mut centroid {
        *value /= total_weight;
    }
    let mag = dot_f64(&centroid, &centroid, dim).sqrt();
    if mag <= 1e-9 {
        return None;
    }
    for value in &mut centroid {
        *value /= mag;
    }
    Some(residual_norm_from_basis(
        tag_vec,
        std::slice::from_ref(&centroid),
        dim,
    ))
}

pub(crate) fn compute_anchored_gs_residual(
    tag_vec: &[f32],
    neighbors: &[TagResidualNeighbor],
    tag_vectors: &std::collections::HashMap<i64, Vec<f32>>,
    dim: usize,
    cfg: &TagResidualConfig,
) -> Option<f64> {
    let mut basis: Vec<Vec<f64>> = Vec::with_capacity(cfg.max_basis);
    let mut residual = tag_vec
        .iter()
        .map(|value| *value as f64)
        .collect::<Vec<_>>();
    let mut used = vec![false; neighbors.len()];

    for _ in 0..cfg.max_basis {
        let mut best_index: Option<usize> = None;
        let mut best_score = 0.0;
        let mut best_unit = Vec::new();
        let mut best_gain = 0.0;

        for (idx, neighbor) in neighbors.iter().enumerate() {
            if used[idx] || neighbor.semantic <= 0.0 {
                continue;
            }
            let source = match tag_vectors.get(&neighbor.id) {
                Some(value) => value,
                None => continue,
            };
            let mut candidate = source.iter().map(|value| *value as f64).collect::<Vec<_>>();
            for u in &basis {
                let dot = dot_f64(&candidate, u, dim);
                for d in 0..dim {
                    candidate[d] -= dot * u[d];
                }
            }

            let orth_norm = dot_f64(&candidate, &candidate, dim).sqrt();
            if orth_norm <= 1e-6 {
                continue;
            }
            for value in &mut candidate {
                *value /= orth_norm;
            }

            let explain_gain = dot_f64(&residual, &candidate, dim).abs();
            let association_weight = (1.0 + neighbor.weight).ln().max(1e-6);
            let score = explain_gain * orth_norm * association_weight * neighbor.semantic;

            if score > best_score {
                best_score = score;
                best_gain = explain_gain;
                best_index = Some(idx);
                best_unit = candidate;
            }
        }

        let Some(idx) = best_index else {
            break;
        };
        if best_gain < cfg.min_gain {
            break;
        }

        used[idx] = true;
        let signed_gain = dot_f64(&residual, &best_unit, dim);
        for d in 0..dim {
            residual[d] -= signed_gain * best_unit[d];
        }
        basis.push(best_unit);
    }

    if basis.is_empty() {
        None
    } else {
        Some(dot_f64(&residual, &residual, dim).sqrt())
    }
}

pub(crate) fn compute_svd_residual(
    tag_vec: &[f32],
    neighbors: &[TagResidualNeighbor],
    tag_vectors: &std::collections::HashMap<i64, Vec<f32>>,
    dim: usize,
    max_k: usize,
) -> Option<f64> {
    use nalgebra::DMatrix;

    let mut flat = Vec::with_capacity(neighbors.len() * dim);
    let mut n = 0usize;
    for neighbor in neighbors {
        if let Some(vec) = tag_vectors.get(&neighbor.id) {
            flat.extend_from_slice(vec);
            n += 1;
        }
    }
    if n == 0 {
        return None;
    }

    let matrix = DMatrix::from_row_slice(n, dim, &flat);
    let svd = matrix.svd(false, true);
    let v_t = svd.v_t?;
    let k = max_k.min(n).min(dim);
    let mut basis = Vec::with_capacity(k);
    for i in 0..k {
        let mut row = Vec::with_capacity(dim);
        for d in 0..dim {
            row.push(v_t[(i, d)] as f64);
        }
        basis.push(row);
    }

    Some(residual_norm_from_basis(tag_vec, &basis, dim))
}

#[cfg(test)]
mod tests {
    use super::{
        compute_centroid_residual, pair_key, semantic_gate, TagResidualConfig, TagResidualNeighbor,
    };
    use std::collections::HashMap;

    #[test]
    fn pair_keys_are_canonical_and_semantic_gate_has_a_floor() {
        assert_eq!(pair_key(9, 2), (2, 9));
        assert_eq!(pair_key(2, 9), (2, 9));
        let config = TagResidualConfig {
            method: super::TagResidualMethod::Centroid,
            max_neighbors: 4,
            max_basis: 2,
            min_neighbors: 1,
            semantic_enabled: true,
            semantic_peak: 0.8,
            semantic_sigma: 0.1,
            semantic_floor: 0.2,
            semantic_hard_floor: 0.1,
            min_gain: 0.01,
        };
        assert_eq!(semantic_gate(0.0, &config), 0.2);
        assert_eq!(semantic_gate(0.05, &config), 0.0);
        assert!(semantic_gate(0.8, &config) > 1.0);
    }

    #[test]
    fn centroid_residual_is_zero_for_an_identical_neighbor_direction() {
        let mut vectors = HashMap::new();
        vectors.insert(2, vec![1.0_f32, 0.0_f32]);
        let residual = compute_centroid_residual(
            &[1.0_f32, 0.0_f32],
            &[TagResidualNeighbor {
                id: 2,
                weight: 1.0,
                semantic: 1.0,
            }],
            &vectors,
            2,
        )
        .unwrap();
        assert!(residual.abs() < 1e-9);
    }
}
