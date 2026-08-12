pub(crate) fn cosine_similarity(a: &[f32], b: &[f32], dim: usize) -> f64 {
    let mut dot = 0.0_f64;
    let mut a_norm = 0.0_f64;
    let mut b_norm = 0.0_f64;
    for index in 0..dim {
        let left = a[index] as f64;
        let right = b[index] as f64;
        dot += left * right;
        a_norm += left * left;
        b_norm += right * right;
    }
    let denominator = a_norm.sqrt() * b_norm.sqrt();
    if denominator > 1e-9 {
        dot / denominator
    } else {
        0.0
    }
}

#[cfg(test)]
mod tests {
    use super::cosine_similarity;

    #[test]
    fn cosine_similarity_is_normalized_and_zero_safe() {
        assert!((cosine_similarity(&[3.0, 4.0], &[3.0, 4.0], 2) - 1.0).abs() < 1e-12);
        assert!(cosine_similarity(&[1.0, 0.0], &[0.0, 1.0], 2).abs() < 1e-12);
        assert_eq!(cosine_similarity(&[0.0, 0.0], &[1.0, 0.0], 2), 0.0);
    }
}
