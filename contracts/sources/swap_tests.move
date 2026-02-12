/// Tests for private swap functionality
#[test_only]
module octopus::swap_tests {
    use sui::test_scenario::{Self as ts, Scenario};
    use sui::coin::{Self, Coin};
    use sui::sui::SUI;
    use sui::clock::{Self, Clock};
    use octopus::pool::{Self, PrivacyPool};
    use token::deep::DEEP;

    // Test token for USDC simulation
    public struct USDC has drop {}

    // Test addresses
    const ADMIN: address = @0xAD;
    const ALICE: address = @0xA11CE;

    // Test verification keys (using same VK for all circuits for testing)
    const TEST_VK: vector<u8> = x"e2f26dbea299f5223b646cb1fb33eadb059d9407559d7441dfd902e3a79a4d2dabb73dc17fbc13021e2471e0c08bd67d8401f52b73d6d07483794cad4778180e0c06f33bbc4c79a9cadef253a68084d382f17788f885c9afd176f7cb2f036789edf692d95cbdde46ddda5ef7d422436779445c5e66006a42761e1f12efde0018c212f3aeb785e49712e7a9353349aaf1255dfb31b7bf60723a480d9293938e198f1ca32b8c078cd1ecfc4a467d8db364b3757d39102fa1ed9255e280333144297c184af83775c6ea998cfb4d59fbd7317b3435e152bace861d478fe0bbcf148f0400000000000000191f71d49c7ecfcc3643957f0d503d24e713cf91937a8a33b7c118a6afef44891ef0fa65bcfbe5a8f6a5a1bb098b6e508467a66a10af02338ce1560ff9609f1588d71006852b8f431fd5d3de34357325e41f3252748926d16c27ed7cb789478068d1e927470885642b8adcd4b38f20583984d85f9274e93b39f834daacf80b0b";

    // Test commitments
    const TEST_COMMITMENT_1: vector<u8> = x"1c09f7c851fc99ab1c0a4e8bd8e43be4d7e0cbfc24ea3e1567f4c6e4e91d2d1b";
    const TEST_COMMITMENT_2: vector<u8> = x"1ee8a9e914d93ea80f7f5f7bae93c4e8cc02f0c99f59f4fe86ca57e87b872a76";

    // Test nullifiers
    const TEST_NULLIFIER_1: vector<u8> = x"26ae6f0b1c18b374b0f8e96f0ffee84f8de5f8a3c0a18cb74e76ec54f4a1d550";
    const TEST_NULLIFIER_2: vector<u8> = x"0e26e4d01f8e08a65bb60f2f3c18e45a82e6c41f93cfbb5ac8e6a0f82ad5fad4";

    // Test output commitments (for swap outputs)
    const TEST_OUTPUT_COMMITMENT: vector<u8> = x"2ce085bcaac45e2f4e54b4bda0c2a59d6f10f6e4e41e5e3f0e4e2e0e8e6e4e60";
    const TEST_CHANGE_COMMITMENT: vector<u8> = x"2015cf64f6a59f63a4f6e4e41e5e3f0e4e2e0e8e6e4e602ce085bcaac45e2f4e";

    // Placeholder token identifiers (32 bytes each)
    const TEST_TOKEN_IN: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000001";
    const TEST_TOKEN_OUT: vector<u8> = x"0000000000000000000000000000000000000000000000000000000000000002";

    // Placeholder swap proof (128 bytes for Groth16)
    const TEST_SWAP_PROOF: vector<u8> = x"aca940a9ad7c4beb620beb1b67cd111a2ff32b2f33945bd12cc017c721ec1b91083135faffb3ff4b3cfdcdd0a075154e80b245fa42d14655880096b4ef29fe13f274371b7b8b1d8382f61ba9b61d2901b3557944195ee34771eaee3f0019571cba7b3a4b43ffdd48945edd122d141734a262be4b49e6baf28abeea0c1484050a";

    // ============ Helper Functions ============

    fun create_test_pools(scenario: &mut Scenario) {
        ts::next_tx(scenario, ADMIN);
        {
            let ctx = ts::ctx(scenario);
            // Create SUI pool
            pool::create_shared_pool<SUI>(TEST_VK, TEST_VK, TEST_VK, ctx);

            // Create USDC pool
            pool::create_shared_pool<USDC>(TEST_VK, TEST_VK, TEST_VK, ctx);
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

    fun shield_sui(
        scenario: &mut Scenario,
        sender: address,
        _amount: u64,
        commitment: vector<u8>,
    ) {
        ts::next_tx(scenario, sender);
        {
            let mut pool = ts::take_shared<PrivacyPool<SUI>>(scenario);
            let coin = ts::take_from_sender<Coin<SUI>>(scenario);
            let ctx = ts::ctx(scenario);

            pool::shield(&mut pool, coin, commitment, vector::empty(), ctx);

            ts::return_shared(pool);
        };
    }

    // Build swap public inputs (256 bytes)
    // Format: token_in || token_out || merkle_root || nullifier1 || nullifier2 || swap_data_hash || output_commitment || change_commitment
    fun build_swap_public_inputs(
        token_in: vector<u8>,
        token_out: vector<u8>,
        root: vector<u8>,
        nullifier1: vector<u8>,
        nullifier2: vector<u8>,
        swap_data_hash: vector<u8>,
        output_commitment: vector<u8>,
        change_commitment: vector<u8>,
    ): vector<u8> {
        let mut public_inputs = vector::empty<u8>();
        vector::append(&mut public_inputs, token_in);
        vector::append(&mut public_inputs, token_out);
        vector::append(&mut public_inputs, root);
        vector::append(&mut public_inputs, nullifier1);
        vector::append(&mut public_inputs, nullifier2);
        vector::append(&mut public_inputs, swap_data_hash);
        vector::append(&mut public_inputs, output_commitment);
        vector::append(&mut public_inputs, change_commitment);
        public_inputs
    }

    // ============ Tests ============

    #[test]
    fun test_swap_pools_creation() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Verify SUI pool exists
        ts::next_tx(&mut scenario, ALICE);
        {
            let pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            assert!(pool::get_note_count(&pool_sui) == 0, 0);
            assert!(pool::get_balance(&pool_sui) == 0, 1);
            ts::return_shared(pool_sui);
        };

        // Verify USDC pool exists
        {
            let pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            assert!(pool::get_note_count(&pool_usdc) == 0, 2);
            assert!(pool::get_balance(&pool_usdc) == 0, 3);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_swap_sui_to_usdc_success() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Alice shields 100 SUI
        mint_sui(&mut scenario, 100_000_000_000, ALICE); // 100 SUI
        shield_sui(&mut scenario, ALICE, 100_000_000_000, TEST_COMMITMENT_1);

        // Shield second note
        mint_sui(&mut scenario, 50_000_000_000, ALICE); // 50 SUI
        shield_sui(&mut scenario, ALICE, 50_000_000_000, TEST_COMMITMENT_2);

        // Execute swap: 100 SUI → USDC
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_sui);
            let swap_data_hash = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_IN,
                TEST_TOKEN_OUT,
                root,
                TEST_NULLIFIER_1,
                TEST_NULLIFIER_2,
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                TEST_CHANGE_COMMITMENT,
            );

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                public_inputs,
                100_000_000_000, // amount_in
                95_000_000_000,  // min_amount_out (5% slippage)
                coin::mint_for_testing<DEEP>(0, ctx), // deep_in (zero for testing)
                &clock, // clock
                vector::empty<u8>(), // encrypted_output_note
                vector::empty<u8>(), // encrypted_change_note
                ctx
            );
            clock::destroy_for_testing(clock);

            // Verify nullifiers are spent
            assert!(pool::is_nullifier_spent(&pool_sui, TEST_NULLIFIER_1), 0);
            assert!(pool::is_nullifier_spent(&pool_sui, TEST_NULLIFIER_2), 1);

            // Verify commitments added to trees
            assert!(pool::get_note_count(&pool_usdc) == 1, 2); // Output commitment
            assert!(pool::get_note_count(&pool_sui) == 3, 3); // Original 2 + change

            // Verify balances (mock swap is 1:1)
            assert!(pool::get_balance(&pool_sui) == 50_000_000_000, 4); // 150 - 100 = 50
            assert!(pool::get_balance(&pool_usdc) == 100_000_000_000, 5); // Received 100 USDC

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = pool::E_DOUBLE_SPEND)]
    fun test_swap_double_spend_fails() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Alice shields SUI
        mint_sui(&mut scenario, 100_000_000_000, ALICE);
        shield_sui(&mut scenario, ALICE, 100_000_000_000, TEST_COMMITMENT_1);

        mint_sui(&mut scenario, 50_000_000_000, ALICE);
        shield_sui(&mut scenario, ALICE, 50_000_000_000, TEST_COMMITMENT_2);

        // First swap succeeds
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_sui);
            let swap_data_hash = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_IN,
                TEST_TOKEN_OUT,
                root,
                TEST_NULLIFIER_1,
                TEST_NULLIFIER_2,
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                TEST_CHANGE_COMMITMENT,
            );

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                public_inputs,
                100_000_000_000,
                95_000_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        // Second swap with same nullifiers should fail
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_sui);
            let swap_data_hash = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_IN,
                TEST_TOKEN_OUT,
                root,
                TEST_NULLIFIER_1, // Same nullifier - should fail
                TEST_NULLIFIER_2,
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                TEST_CHANGE_COMMITMENT,
            );

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                public_inputs,
                100_000_000_000,
                95_000_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = pool::E_INSUFFICIENT_BALANCE)]
    fun test_swap_insufficient_balance_fails() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Alice shields only 10 SUI
        mint_sui(&mut scenario, 10_000_000_000, ALICE);
        shield_sui(&mut scenario, ALICE, 10_000_000_000, TEST_COMMITMENT_1);

        // Try to swap 100 SUI (more than balance) - should fail
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_sui);
            let swap_data_hash = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_IN,
                TEST_TOKEN_OUT,
                root,
                TEST_NULLIFIER_1,
                TEST_NULLIFIER_2,
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                TEST_CHANGE_COMMITMENT,
            );

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                public_inputs,
                100_000_000_000, // More than pool balance
                95_000_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    #[expected_failure(abort_code = pool::E_INVALID_PUBLIC_INPUTS)]
    fun test_swap_invalid_public_inputs_length_fails() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        mint_sui(&mut scenario, 100_000_000_000, ALICE);
        shield_sui(&mut scenario, ALICE, 100_000_000_000, TEST_COMMITMENT_1);

        // Try swap with wrong public inputs length (192 bytes instead of 256)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let invalid_public_inputs = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                invalid_public_inputs,
                100_000_000_000,
                95_000_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_swap_with_zero_change() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Shield exactly the swap amount (no change expected)
        mint_sui(&mut scenario, 100_000_000_000, ALICE);
        shield_sui(&mut scenario, ALICE, 100_000_000_000, TEST_COMMITMENT_1);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_sui);
            let swap_data_hash = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            // Use dummy nullifier for second input (zero value)
            let dummy_nullifier = x"0000000000000000000000000000000000000000000000000000000000000000";

            // Use actual zero commitment (all bytes = 0) for zero change
            let zero_change_commitment = x"0000000000000000000000000000000000000000000000000000000000000000";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_IN,
                TEST_TOKEN_OUT,
                root,
                TEST_NULLIFIER_1,
                dummy_nullifier, // Second input is dummy (value = 0)
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                zero_change_commitment, // Zero commitment (all bytes = 0)
            );

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                public_inputs,
                100_000_000_000,
                95_000_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            // Verify change commitment NOT added when zero (fixed bug)
            assert!(pool::get_note_count(&pool_sui) == 1, 0); // Only original note (no zero change)

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_swap_reverse_direction_usdc_to_sui() {
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Alice shields USDC first (simulating previous swap output)
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let coin_usdc = coin::mint_for_testing<USDC>(100_000_000, ctx);
            pool::shield(&mut pool_usdc, coin_usdc, TEST_COMMITMENT_1, vector::empty(), ctx);

            ts::return_shared(pool_usdc);
        };

        // Now swap USDC → SUI
        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_usdc); // Root from USDC pool
            let swap_data_hash = x"abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_OUT, // token_in is now USDC
                TEST_TOKEN_IN,  // token_out is now SUI
                root,
                TEST_NULLIFIER_1,
                TEST_NULLIFIER_2,
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                TEST_CHANGE_COMMITMENT,
            );

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<USDC, SUI>(
                &mut pool_usdc,
                &mut pool_sui,
                TEST_SWAP_PROOF,
                public_inputs,
                100_000_000,
                95_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            // Verify swap succeeded
            assert!(pool::is_nullifier_spent(&pool_usdc, TEST_NULLIFIER_1), 0);
            assert!(pool::get_balance(&pool_sui) == 100_000_000, 1); // Received SUI

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }

    #[test]
    fun test_swap_with_nonzero_change() {
        // Test that non-zero change commitments ARE added to the tree
        let mut scenario = ts::begin(ADMIN);
        create_test_pools(&mut scenario);

        // Shield initial SUI for swap
        ts::next_tx(&mut scenario, ALICE);
        mint_sui(&mut scenario, 100_000_000_000, ALICE);
        shield_sui(&mut scenario, ALICE, 100_000_000_000, TEST_COMMITMENT_1);

        ts::next_tx(&mut scenario, ALICE);
        {
            let mut pool_sui = ts::take_shared<PrivacyPool<SUI>>(&scenario);
            let mut pool_usdc = ts::take_shared<PrivacyPool<USDC>>(&scenario);
            let ctx = ts::ctx(&mut scenario);

            let root = pool::get_merkle_root(&pool_sui);
            let swap_data_hash = x"1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef";

            // Use non-zero commitment for change (simulating partial swap)
            let nonzero_change_commitment = x"0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

            let public_inputs = build_swap_public_inputs(
                TEST_TOKEN_IN,
                TEST_TOKEN_OUT,
                root,
                TEST_NULLIFIER_1,
                TEST_NULLIFIER_2,
                swap_data_hash,
                TEST_OUTPUT_COMMITMENT,
                nonzero_change_commitment, // Non-zero change commitment
            );

            let initial_note_count = pool::get_note_count(&pool_sui);

            let clock = clock::create_for_testing(ctx);
            pool::swap_for_testing<SUI, USDC>(
                &mut pool_sui,
                &mut pool_usdc,
                TEST_SWAP_PROOF,
                public_inputs,
                50_000_000_000, // Swap only half
                47_500_000_000,
                coin::mint_for_testing<DEEP>(0, ctx),
                &clock,
                vector::empty<u8>(),
                vector::empty<u8>(),
                ctx
            );
            clock::destroy_for_testing(clock);

            // Verify change commitment WAS added (non-zero)
            assert!(pool::get_note_count(&pool_sui) == initial_note_count + 1, 0); // Change added
            assert!(pool::get_note_count(&pool_usdc) == 1, 1); // Output added

            ts::return_shared(pool_sui);
            ts::return_shared(pool_usdc);
        };

        ts::end(scenario);
    }
}
