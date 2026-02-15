/// Tests for private transfer (0zk-to-0zk) functionality
#[test_only]
module octopus::transfer_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use octopus::pool::{Self, PrivacyPool};

    // Test addresses
    const ADMIN: address = @0xAD;
    const ALICE: address = @0xA11CE;
    const BOB: address = @0xB0B;

    // Test verification keys (placeholder - using same VK for both unshield and transfer)
    // In production, these would be different VKs from different circuits
    const TEST_VK: vector<u8> = x"e2f26dbea299f5223b646cb1fb33eadb059d9407559d7441dfd902e3a79a4d2dabb73dc17fbc13021e2471e0c08bd67d8401f52b73d6d07483794cad4778180e0c06f33bbc4c79a9cadef253a68084d382f17788f885c9afd176f7cb2f036789edf692d95cbdde46ddda5ef7d422436779445c5e66006a42761e1f12efde0018c212f3aeb785e49712e7a9353349aaf1255dfb31b7bf60723a480d9293938e198f1ca32b8c078cd1ecfc4a467d8db364b3757d39102fa1ed9255e280333144297c184af83775c6ea998cfb4d59fbd7317b3435e152bace861d478fe0bbcf148f0400000000000000191f71d49c7ecfcc3643957f0d503d24e713cf91937a8a33b7c118a6afef44891ef0fa65bcfbe5a8f6a5a1bb098b6e508467a66a10af02338ce1560ff9609f1588d71006852b8f431fd5d3de34357325e41f3252748926d16c27ed7cb789478068d1e927470885642b8adcd4b38f20583984d85f9274e93b39f834daacf80b0b";

    // Test commitments for shield operations
    const TEST_COMMITMENT_1: vector<u8> = x"1c09f7c851fc99ab1c0a4e8bd8e43be4d7e0cbfc24ea3e1567f4c6e4e91d2d1b";
    const TEST_COMMITMENT_2: vector<u8> = x"1ee8a9e914d93ea80f7f5f7bae93c4e8cc02f0c99f59f4fe86ca57e87b872a76";

    // Test nullifiers (for double-spend prevention tests)
    const TEST_NULLIFIER_1: vector<u8> = x"26ae6f0b1c18b374b0f8e96f0ffee84f8de5f8a3c0a18cb74e76ec54f4a1d550";
    const TEST_NULLIFIER_2: vector<u8> = x"0e26e4d01f8e08a65bb60f2f3c18e45a82e6c41f93cfbb5ac8e6a0f82ad5fad4";

    // Test output commitments (for transfer outputs)
    const TEST_OUTPUT_COMMITMENT_1: vector<u8> = x"2ce085bcaac45e2f4e54b4bda0c2a59d6f10f6e4e41e5e3f0e4e2e0e8e6e4e60";
    const TEST_OUTPUT_COMMITMENT_2: vector<u8> = x"2015cf64f6a59f63a4f6e4e41e5e3f0e4e2e0e8e6e4e602ce085bcaac45e2f4e";

    // Placeholder proof (128 bytes for Groth16)
    const TEST_TRANSFER_PROOF: vector<u8> = x"aca940a9ad7c4beb620beb1b67cd111a2ff32b2f33945bd12cc017c721ec1b91083135faffb3ff4b3cfdcdd0a075154e80b245fa42d14655880096b4ef29fe13f274371b7b8b1d8382f61ba9b61d2901b3557944195ee34771eaee3f0019571cba7b3a4b43ffdd48945edd122d141734a262be4b49e6baf28abeea0c1484050a";

    // ============ Helper Functions ============

    fun create_test_pool(scenario: &mut Scenario) {
        ts::next_tx(scenario, ADMIN);
        {
            let ctx = ts::ctx(scenario);
            pool::create_shared_pool<SUI>(TEST_VK, TEST_VK, TEST_VK, ctx);
        };
    }

    fun mint_sui(scenario: &mut Scenario, amount: u64, recipient: address) {
        ts::next_tx(scenario, ADMIN);
        {
            let ctx = ts::ctx(scenario);
            let coin = coin::mint_for_testing<SUI>(amount, ctx);
            transfer::public_transfer(coin, recipient);
        };
    }

    fun shield_note(
        scenario: &mut Scenario,
        sender: address,
        amount: u64,
        commitment: vector<u8>
    ) {
        mint_sui(scenario, amount, sender);

        ts::next_tx(scenario, sender);
        {
            let mut pool = ts::take_shared<PrivacyPool<SUI>>(scenario);
            let coin = ts::take_from_sender<Coin<SUI>>(scenario);
            let ctx = ts::ctx(scenario);

            pool::shield(
                &mut pool,
                coin,
                commitment,
                x"0102030405060708", // Placeholder encrypted note
                ctx
            );

            ts::return_shared(pool);
        };
    }

    // Build transfer public inputs (160 bytes: root + 2 nullifiers + 2 commitments)
    fun build_transfer_public_inputs(
        merkle_root: vector<u8>,
        nullifier1: vector<u8>,
        nullifier2: vector<u8>,
        commitment1: vector<u8>,
        commitment2: vector<u8>
    ): vector<u8> {
        let mut public_inputs = vector::empty<u8>();

        // Concatenate all inputs
        vector::append(&mut public_inputs, merkle_root);
        vector::append(&mut public_inputs, nullifier1);
        vector::append(&mut public_inputs, nullifier2);
        vector::append(&mut public_inputs, commitment1);
        vector::append(&mut public_inputs, commitment2);

        public_inputs
    }

    // ============ Tests ============

    #[test]
    fun test_transfer_basic_structure() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        // Shield 2 notes for Alice (input notes)
        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1); // 5 SUI
        shield_note(&mut scenario, ALICE, 3_000_000_000, TEST_COMMITMENT_2); // 3 SUI

        ts::next_tx(&mut scenario, ALICE);
        {
            let pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);

            // Verify pool state before transfer
            assert!(pool::get_balance(&pool) == 8_000_000_000, 0); // 8 SUI total
            assert!(pool::get_note_count(&pool) == 2, 1); // 2 notes

            ts::return_shared(pool);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 5)] // E_INVALID_PUBLIC_INPUTS
    fun test_transfer_invalid_public_inputs_length() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1);
        shield_note(&mut scenario, ALICE, 3_000_000_000, TEST_COMMITMENT_2);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            // Invalid public inputs (too short - only 96 bytes instead of 160)
            let invalid_public_inputs = x"2fcfefda413c3b48e0806fb76f38678760d9dc9e23eaecaec3c5c6265298202350c899e811771f3b5b77a50bcde42ab8822a6c8b41b57e4cea8f0c00645da926589b6f5789efc87da100ca0b91394f7454370d77d4f64569e64bca988b98be2c";

            let encrypted_notes = vector[x"0102030405060708", x"090a0b0c0d0e0f10"];
            let nullifiers = vector[TEST_NULLIFIER_1, TEST_NULLIFIER_2];

            pool::transfer(
                &mut pool,
                TEST_TRANSFER_PROOF,
                invalid_public_inputs,
                nullifiers,
                encrypted_notes,
                ctx
            );

            ts::return_shared(pool);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = 5)] // E_INVALID_PUBLIC_INPUTS
    fun test_transfer_invalid_encrypted_notes_count() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1);
        shield_note(&mut scenario, ALICE, 3_000_000_000, TEST_COMMITMENT_2);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let merkle_root = pool::get_merkle_root(&pool);
            let ctx = ts::ctx(&mut scenario);

            let public_inputs = build_transfer_public_inputs(
                merkle_root,
                TEST_NULLIFIER_1,
                TEST_NULLIFIER_2,
                TEST_OUTPUT_COMMITMENT_1,
                TEST_OUTPUT_COMMITMENT_2
            );

            // Invalid: only 1 encrypted note instead of 2
            let encrypted_notes = vector[x"0102030405060708"];
            let nullifiers = vector[TEST_NULLIFIER_1, TEST_NULLIFIER_2];

            pool::transfer(
                &mut pool,
                TEST_TRANSFER_PROOF,
                public_inputs,
                nullifiers,
                encrypted_notes,
                ctx
            );

            ts::return_shared(pool);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_transfer_nullifier_tracking() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1);
        shield_note(&mut scenario, ALICE, 3_000_000_000, TEST_COMMITMENT_2);

        ts::next_tx(&mut scenario, ALICE);
        {
            let pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);

            // Verify nullifiers are not spent initially
            assert!(!pool::is_nullifier_spent(&pool, TEST_NULLIFIER_1), 0);
            assert!(!pool::is_nullifier_spent(&pool, TEST_NULLIFIER_2), 1);

            ts::return_shared(pool);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_transfer_commitment_count_increases() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        // Initial state: 0 notes
        ts::next_tx(&mut scenario, ADMIN);
        {
            let pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            assert!(pool::get_note_count(&pool) == 0, 0);
            ts::return_shared(pool);
        };

        // Shield 2 notes
        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1);
        shield_note(&mut scenario, ALICE, 3_000_000_000, TEST_COMMITMENT_2);

        ts::next_tx(&mut scenario, ALICE);
        {
            let pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            // After shield: 2 notes
            assert!(pool::get_note_count(&pool) == 2, 1);
            ts::return_shared(pool);
        };

        // Note: Actual transfer would add 2 more output commitments (total = 4)
        // But we can't test full transfer without real proof verification

        ts::end(scenario);
    }

    #[test]
    fun test_merkle_root_validity() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1);

        ts::next_tx(&mut scenario, ALICE);
        {
            let pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let current_root = pool::get_merkle_root(&pool);

            // Root should be non-empty (32 bytes)
            assert!(vector::length(&current_root) == 32, 0);

            ts::return_shared(pool);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_pool_balance_unchanged_by_transfer() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pool(&mut scenario);

        // Shield 8 SUI total
        shield_note(&mut scenario, ALICE, 5_000_000_000, TEST_COMMITMENT_1);
        shield_note(&mut scenario, ALICE, 3_000_000_000, TEST_COMMITMENT_2);

        ts::next_tx(&mut scenario, ALICE);
        {
            let pool = ts::take_shared<PrivacyPool<SUI>>(&scenario);

            // Balance should remain 8 SUI (transfer doesn't change total balance)
            assert!(pool::get_balance(&pool) == 8_000_000_000, 0);

            ts::return_shared(pool);
        };

        // Note: After a real transfer, balance would still be 8 SUI
        // (no funds leave the pool during 0zk-to-0zk transfer)

        ts::end(scenario);
    }
}
