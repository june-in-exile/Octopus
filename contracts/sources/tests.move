/// Unit tests for Octopus core data structures
#[test_only]
module octopus::tests {
    use sui::test_scenario::{Self as ts};
    use octopus::merkle_tree::{Self};
    use octopus::nullifier::{Self};

    const ADMIN: address = @0xAD;

    // ============ Merkle Tree Tests ============

    #[test]
    fun test_merkle_tree_new() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let tree = merkle_tree::new(ctx);

            // Initial state
            assert!(merkle_tree::get_next_index(&tree) == 0, 0);
            let root = merkle_tree::get_root(&tree);
            assert!(vector::length(&root) == 32, 1);

            merkle_tree::destroy_for_testing(tree);
        };
        ts::end(scenario);
    }

    #[test]
    fun test_merkle_tree_insert() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut tree = merkle_tree::new(ctx);

            // Insert first leaf
            let leaf1 = x"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            let root_before = merkle_tree::get_root(&tree);
            merkle_tree::insert(&mut tree, leaf1);
            let root_after = merkle_tree::get_root(&tree);

            // Root should change after insertion
            assert!(root_before != root_after, 0);
            assert!(merkle_tree::get_next_index(&tree) == 1, 1);

            // Insert second leaf
            let leaf2 = x"fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";
            let root_before_2 = merkle_tree::get_root(&tree);
            merkle_tree::insert(&mut tree, leaf2);
            let root_after_2 = merkle_tree::get_root(&tree);

            assert!(root_before_2 != root_after_2, 2);
            assert!(merkle_tree::get_next_index(&tree) == 2, 3);

            merkle_tree::destroy_for_testing(tree);
        };
        ts::end(scenario);
    }

    #[test]
    fun test_merkle_tree_multiple_inserts() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut tree = merkle_tree::new(ctx);

            // Insert 10 leaves
            let mut i = 0u64;
            while (i < 10) {
                let mut leaf = vector::empty<u8>();
                let mut j = 0u64;
                while (j < 32) {
                    vector::push_back(&mut leaf, ((i + j) as u8));
                    j = j + 1;
                };
                merkle_tree::insert(&mut tree, leaf);
                i = i + 1;
            };

            assert!(merkle_tree::get_next_index(&tree) == 10, 0);

            merkle_tree::destroy_for_testing(tree);
        };
        ts::end(scenario);
    }

    #[test]
    fun test_merkle_tree_deterministic() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut tree1 = merkle_tree::new(ctx);

            let leaf = x"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
            merkle_tree::insert(&mut tree1, leaf);
            let root1 = merkle_tree::get_root(&tree1);
            merkle_tree::destroy_for_testing(tree1);

            let ctx2 = ts::ctx(&mut scenario);
            let mut tree2 = merkle_tree::new(ctx2);
            merkle_tree::insert(&mut tree2, leaf);
            let root2 = merkle_tree::get_root(&tree2);

            // Same leaf should produce same root
            assert!(root1 == root2, 0);

            merkle_tree::destroy_for_testing(tree2);
        };
        ts::end(scenario);
    }

    // ============ Note Tests ============

    // ============ Nullifier Tests ============

    #[test]
    #[expected_failure] // Aborts when trying to add duplicate dynamic field
    fun test_nullifier_double_spend() {
        let mut scenario = ts::begin(ADMIN);
        {
            let ctx = ts::ctx(&mut scenario);
            let mut registry = nullifier::new(ctx);

            let nullifier_hash = x"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

            // First spend should succeed
            nullifier::mark_spent(&mut registry, nullifier_hash);

            // Second spend should fail (double-spend)
            nullifier::mark_spent(&mut registry, nullifier_hash);

            nullifier::destroy_for_testing(registry);
        };
        ts::end(scenario);
    }

    // ============ Integration Tests ============


}
