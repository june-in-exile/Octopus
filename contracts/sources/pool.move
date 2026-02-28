/// Privacy Pool for Octopus on Sui
/// Implements shield (deposit) and unshield (withdraw with ZK proof) functionality
module octopus::pool {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::groth16;
    use sui::poseidon;
    use sui::event;
    use sui::clock::Clock;
    use octopus::merkle_tree::{Self, MerkleTree};
    use octopus::nullifier::{Self, NullifierRegistry};
    use deepbook::pool::{Self, Pool as DeepBookPool};
    use token::deep::DEEP;

    // ============ Errors ============

    /// Nullifier has already been spent (double-spend attempt)
    const E_DOUBLE_SPEND: u64 = 1;
    /// ZK proof verification failed
    const E_INVALID_PROOF: u64 = 2;
    /// Merkle root is not valid (not current or in history)
    const E_INVALID_ROOT: u64 = 3;
    /// Insufficient balance in pool
    const E_INSUFFICIENT_BALANCE: u64 = 4;
    /// Invalid public inputs format
    const E_INVALID_PUBLIC_INPUTS: u64 = 5;
    /// Cannot shield zero amount
    const E_ZERO_AMOUNT: u64 = 6;
    /// Price too low (slippage protection)
    const E_PRICE_TOO_LOW: u64 = 7;

    // ============ Constants ============

    /// Number of historical roots to keep for proof validity
    const ROOT_HISTORY_SIZE: u64 = 100;

    // ============ Structs ============

    /// Admin capability for managing pool verification keys.
    /// Allows updating VKs when circuit changes are made during development.
    public struct PoolAdminCap has key, store {
        id: UID,
        /// ID of the pool this admin cap controls
        pool_id: ID,
    }

    /// Main privacy pool holding shielded tokens of type T.
    /// Each token type has its own pool instance.
    public struct PrivacyPool<phantom T> has key, store {
        id: UID,
        /// Total shielded balance
        balance: Balance<T>,
        /// Merkle tree tracking note commitments
        merkle_tree: MerkleTree,
        /// Registry of spent nullifiers
        nullifiers: NullifierRegistry,
        /// Groth16 verification key for unshield (Arkworks compressed format)
        vk_bytes: vector<u8>,
        /// Groth16 verification key for transfer (Arkworks compressed format)
        transfer_vk_bytes: vector<u8>,
        /// Groth16 verification key for swap (Arkworks compressed format)
        swap_vk_bytes: vector<u8>,
        /// Historical merkle roots for proof validity window
        historical_roots: vector<vector<u8>>,
        /// Next write position in the circular root history buffer
        root_head: u64,
    }

    /// Event emitted when tokens are shielded (deposited) into the pool
    public struct ShieldEvent has copy, drop {
        /// Pool ID where the note was created
        pool_id: ID,
        /// Position of the commitment in the Merkle tree
        position: u64,
        /// Note commitment hash
        commitment: vector<u8>,
        /// Encrypted note data for recipient to scan
        encrypted_note: vector<u8>,
    }

    /// Event emitted when tokens are unshielded (withdrawn) from the pool
    public struct UnshieldEvent has copy, drop {
        /// Pool ID where the unshield occurred
        pool_id: ID,
        /// Nullifiers that were spent (up to 2)
        input_nullifiers: vector<vector<u8>>,
        /// Recipient address
        recipient: address,
        /// Amount withdrawn
        amount: u64,
    }

    /// Event emitted when tokens are transferred privately within the pool
    public struct TransferEvent has copy, drop {
        /// Pool ID where the transfer occurred
        pool_id: ID,
        /// Nullifiers that were spent (2 inputs)
        input_nullifiers: vector<vector<u8>>,
        /// Positions of output commitments in tree
        output_positions: vector<u64>,
        /// New commitments created (2 outputs)
        output_commitments: vector<vector<u8>>,
        /// Encrypted note for transferred amount and change (if any)
        output_notes: vector<vector<u8>>,
    }

    /// Event emitted when tokens are swapped privately through DEX
    #[allow(unused_field)]
    public struct SwapEvent has copy, drop {
        /// Input pool ID where notes were spent
        pool_in_id: ID,
        /// Output pool ID where note was created
        pool_out_id: ID,
        /// Amount swapped in
        amount_in: u64,
        /// Amount received out
        amount_out: u64,
        /// Nullifiers that were spent (2 inputs)
        input_nullifiers: vector<vector<u8>>,
        /// Position of output commitment in output pool tree
        swap_position: u64,
        /// Swap commitment (for swapped token)
        swap_commitment: vector<u8>,
        /// Encrypted notes for recipient to scan
        encrypted_output_note: vector<u8>,
    }

    // ============ Public Functions ============

    /// Create a new privacy pool for token type T with the given verification keys.
    /// The verification keys are generated from circuit compilation (unshield, transfer, swap).
    fun create_pool<T>(
        vk_bytes: vector<u8>,
        transfer_vk_bytes: vector<u8>,
        swap_vk_bytes: vector<u8>,
        ctx: &mut TxContext,
    ): PrivacyPool<T> {
        PrivacyPool {
            id: object::new(ctx),
            balance: balance::zero(),
            merkle_tree: merkle_tree::new(ctx),
            nullifiers: nullifier::new(ctx),
            vk_bytes,
            transfer_vk_bytes,
            swap_vk_bytes,
            historical_roots: vector::empty(),
            root_head: 0,
        }
    }

    /// Create and share a privacy pool as a shared object.
    /// This is the typical way to deploy a pool for public use.
    /// Returns an AdminCap to the caller for managing verification keys.
    public fun create_shared_pool<T>(
        vk_bytes: vector<u8>,
        transfer_vk_bytes: vector<u8>,
        swap_vk_bytes: vector<u8>,
        ctx: &mut TxContext,
    ) {
        let pool = create_pool<T>(vk_bytes, transfer_vk_bytes, swap_vk_bytes, ctx);
        let pool_id = object::id(&pool);

        // Create admin capability for pool management
        let admin_cap = PoolAdminCap {
            id: object::new(ctx),
            pool_id,
        };

        transfer::share_object(pool);
        transfer::transfer(admin_cap, tx_context::sender(ctx));
    }

    // ============ Admin Functions ============

    /// Update the unshield verification key.
    /// Only callable by the admin cap holder.
    /// Used when the unshield circuit is updated during development.
    public fun update_unshield_vk<T>(
        pool: &mut PrivacyPool<T>,
        admin_cap: &PoolAdminCap,
        new_vk_bytes: vector<u8>,
    ) {
        assert_admin_cap(pool, admin_cap);
        pool.vk_bytes = new_vk_bytes;
    }

    /// Update the transfer verification key.
    /// Only callable by the admin cap holder.
    /// Used when the transfer circuit is updated during development.
    public fun update_transfer_vk<T>(
        pool: &mut PrivacyPool<T>,
        admin_cap: &PoolAdminCap,
        new_vk_bytes: vector<u8>,
    ) {
        assert_admin_cap(pool, admin_cap);
        pool.transfer_vk_bytes = new_vk_bytes;
    }

    /// Update the swap verification key.
    /// Only callable by the admin cap holder.
    /// Used when the swap circuit is updated during development.
    public fun update_swap_vk<T>(
        pool: &mut PrivacyPool<T>,
        admin_cap: &PoolAdminCap,
        new_vk_bytes: vector<u8>,
    ) {
        assert_admin_cap(pool, admin_cap);
        pool.swap_vk_bytes = new_vk_bytes;
    }

    // ============ Core Pool Functions ============

    /// Shield tokens into the privacy pool.
    ///
    /// The commitment is computed off-chain using the following formulas:
    /// - MPK = Poseidon(spending_key, nullifying_key)
    /// - NSK = Poseidon(MPK, random)
    /// - commitment = Poseidon(NSK, token, amount)
    ///
    /// The encrypted_note allows the recipient to scan and identify their notes.
    public fun shield<T>(
        pool: &mut PrivacyPool<T>,
        coin: Coin<T>,
        commitment: vector<u8>,
        encrypted_note: vector<u8>,
        _ctx: &mut TxContext,
    ) {
        // 0. Validate amount is greater than zero
        assert!(coin::value(&coin) > 0, E_ZERO_AMOUNT);

        // 1. Save current root before inserting (so existing proofs remain valid)
        save_historical_root(pool);

        // 2. Record position before insert
        let position = merkle_tree::get_next_index(&pool.merkle_tree);

        // 3. Take coin into pool balance
        balance::join(&mut pool.balance, coin::into_balance(coin));

        // 4. Insert commitment into Merkle tree
        merkle_tree::insert(&mut pool.merkle_tree, commitment);

        // 5. Emit event for wallet scanning
        event::emit(ShieldEvent {
            pool_id: object::id(pool),
            position,
            commitment,
            encrypted_note
        });
    }

    /// Unshield tokens from the privacy pool with ZK proof verification and automatic change handling.
    ///
    /// The ZK proof proves:
    /// 1. Knowledge of spending_key and nullifying_key (ownership)
    /// 2. Input notes (up to 2) exist in Merkle tree
    /// 3. Correct nullifier computation: nullifier = Poseidon(nullifying_key, leaf_index)
    /// 4. Balance conservation: sum(input_amounts) = unshield_amount + change_amount
    /// 5. Correct change commitment computation (if change exists)
    /// 6. Proof is bound to recipient: recipient_hash = Poseidon(addr_lo, addr_hi)
    ///
    /// Public signals format (192 bytes total):
    /// Public outputs (computed by circuit):
    /// - nullifiers_hash (32 bytes): Poseidon(nullifier1, nullifier2)
    /// - change_commitment (32 bytes): Commitment for change note (0 if no change)
    /// - recipient_hash (32 bytes): Poseidon(addr_lo, addr_hi) of recipient address
    /// Public inputs (provided by user):
    /// - unshield_amount (32 bytes): Amount to withdraw (as field element)
    /// - token (32 bytes): Token type identifier
    /// - merkle_root (32 bytes): Merkle tree root
    ///
    /// Nullifiers are passed explicitly (not embedded in public inputs) to keep them private.
    public fun unshield<T>(
        pool: &mut PrivacyPool<T>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        nullifiers: vector<vector<u8>>,
        recipient: address,
        encrypted_change_note: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // Validate public inputs length (6 field elements × 32 bytes = 192 bytes)
        assert!(vector::length(&public_inputs_bytes) == 192, E_INVALID_PUBLIC_INPUTS);
        assert!(vector::length(&nullifiers) == 2, E_INVALID_PUBLIC_INPUTS);

        // 1. Parse public inputs [nullifiers_hash, change_commitment, recipient_hash, unshield_amount, token, merkle_root]
        let (nullifiers_hash, change_commitment, proof_recipient_hash, unshield_amount_bytes, _token, merkle_root) =
            parse_unshield_public_inputs(&public_inputs_bytes);

        // 2. Verify the proof is bound to the claimed recipient (prevents relayer substitution).
        //    Checked before the root lookup: cheap Poseidon + comparison, and a wrong recipient
        //    should be rejected immediately regardless of whether the root is valid.
        let computed_recipient_hash = compute_recipient_hash(recipient);
        assert!(computed_recipient_hash == proof_recipient_hash, E_INVALID_PUBLIC_INPUTS);

        // 3. Verify merkle root is valid (current or in history)
        assert!(is_valid_root(pool, &merkle_root), E_INVALID_ROOT);

        let nullifier1 = *vector::borrow(&nullifiers, 0);
        let nullifier2 = *vector::borrow(&nullifiers, 1);

        // 4. Verify the explicitly-passed nullifiers match the nullifiers_hash in the proof
        let n1_u256 = field_element_to_u256(&nullifier1);
        let n2_u256 = field_element_to_u256(&nullifier2);
        let computed_hash = poseidon::poseidon_bn254(&vector[n1_u256, n2_u256]);
        let computed_hash_bytes = u256_to_field_element(computed_hash);
        assert!(computed_hash_bytes == nullifiers_hash, E_INVALID_PUBLIC_INPUTS);

        // Convert unshield_amount from field element to u64
        let amount = field_element_to_u64(&unshield_amount_bytes);

        // 5. Check both nullifiers have not been spent (prevent double-spend)
        assert!(!nullifier::is_spent(&pool.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool.nullifiers, nullifier2), E_DOUBLE_SPEND);

        // 6. Verify Groth16 ZK proof
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &pool.vk_bytes);
        let public_inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        let proof_points = groth16::proof_points_from_bytes(proof_bytes);

        assert!(
            groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &public_inputs, &proof_points),
            E_INVALID_PROOF
        );

        // 7. Mark nullifiers as spent
        nullifier::mark_spent(&mut pool.nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) {
            nullifier::mark_spent(&mut pool.nullifiers, nullifier2);
        };

        // 8. Transfer tokens to recipient
        assert!(balance::value(&pool.balance) >= amount, E_INSUFFICIENT_BALANCE);
        let withdrawn = coin::take(&mut pool.balance, amount, ctx);
        transfer::public_transfer(withdrawn, recipient);

        // 9. Handle change note (if any)
        if (!is_zero_commitment(&change_commitment)) {
            // Save current root to history before inserting change
            save_historical_root(pool);

            // Get position before inserting (next_index is the position where leaf will be inserted)
            let change_position = merkle_tree::get_next_index(&pool.merkle_tree);

            // Insert change commitment into Merkle tree
            merkle_tree::insert(&mut pool.merkle_tree, change_commitment);

            // Emit shield event for change note (so user can scan it)
            event::emit(ShieldEvent {
                pool_id: object::id(pool),
                position: change_position,
                commitment: change_commitment,
                encrypted_note: encrypted_change_note,
            });
        };

        // 9. Emit event
        let mut used_nullifiers = vector::empty<vector<u8>>();
        vector::push_back(&mut used_nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) {
            vector::push_back(&mut used_nullifiers, nullifier2);
        };

        event::emit(UnshieldEvent {
            pool_id: object::id(pool),
            input_nullifiers: used_nullifiers,
            recipient,
            amount,
        });
    }

    /// Transfer tokens privately within the pool (0zk-to-0zk transfer).
    ///
    /// The ZK proof proves:
    /// 1. Knowledge of spending_key and nullifying_key (ownership of both inputs)
    /// 2. Both input notes exist in Merkle tree (2 Merkle proofs)
    /// 3. Correct nullifier computation for both inputs
    /// 4. Correct commitment computation for transfer and change outputs
    /// 5. Balance conservation: sum(input_amounts) = recipient_amount + change_amount
    ///
    /// Public inputs format (160 bytes total):
    /// - nullifiers_hash (32 bytes): Poseidon(nullifier1, nullifier2)
    /// - recipient_commitment (32 bytes): Commitment for transfer to recipient
    /// - change_commitment (32 bytes): Commitment for change back to sender
    /// - token (32 bytes): Token type identifier
    /// - merkle_root (32 bytes): Merkle tree root
    ///
    /// Nullifiers are passed explicitly (not embedded in public inputs) to keep them private.
    public fun transfer<T>(
        pool: &mut PrivacyPool<T>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        nullifiers: vector<vector<u8>>,
        encrypted_notes: vector<vector<u8>>,
        _ctx: &mut TxContext,
    ) {
        // Validate public inputs length (5 field elements × 32 bytes = 160 bytes)
        assert!(vector::length(&public_inputs_bytes) == 160, E_INVALID_PUBLIC_INPUTS);
        assert!(vector::length(&nullifiers) == 2, E_INVALID_PUBLIC_INPUTS);
        assert!(vector::length(&encrypted_notes) == 2, E_INVALID_PUBLIC_INPUTS);

        // 1. Parse public inputs [nullifiers_hash, recipient_commitment, change_commitment, token, merkle_root]
        let (nullifiers_hash, recipient_commitment, change_commitment, _token, merkle_root) =
            parse_transfer_public_inputs(&public_inputs_bytes);

        let nullifier1 = *vector::borrow(&nullifiers, 0);
        let nullifier2 = *vector::borrow(&nullifiers, 1);

        // 2. Verify the explicitly-passed nullifiers match the nullifiers_hash in the proof
        let n1_u256 = field_element_to_u256(&nullifier1);
        let n2_u256 = field_element_to_u256(&nullifier2);
        let computed_hash = poseidon::poseidon_bn254(&vector[n1_u256, n2_u256]);
        let computed_hash_bytes = u256_to_field_element(computed_hash);
        assert!(computed_hash_bytes == nullifiers_hash, E_INVALID_PUBLIC_INPUTS);

        // 2. Verify merkle root is valid (current or in history)
        assert!(is_valid_root(pool, &merkle_root), E_INVALID_ROOT);

        // 3. Check both nullifiers have not been spent (prevent double-spend)
        assert!(!nullifier::is_spent(&pool.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool.nullifiers, nullifier2), E_DOUBLE_SPEND);

        // 4. Verify Groth16 ZK proof
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &pool.transfer_vk_bytes);
        let public_inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        let proof_points = groth16::proof_points_from_bytes(proof_bytes);

        assert!(
            groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &public_inputs, &proof_points),
            E_INVALID_PROOF
        );

        // 5. Mark both nullifiers as spent
        let mut used_nullifiers = vector::empty<vector<u8>>();
        nullifier::mark_spent(&mut pool.nullifiers, nullifier1);
        vector::push_back(&mut used_nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) { // not dummy commit
            nullifier::mark_spent(&mut pool.nullifiers, nullifier2);
            vector::push_back(&mut used_nullifiers, nullifier2);
        };

        // 6. Save current root before inserting (so existing proofs remain valid)
        save_historical_root(pool);

        // 7. Build output vectors for non-zero commitments
        let mut output_notes: vector<vector<u8>> = vector::empty<vector<u8>>();
        let mut output_positions = vector::empty<u64>();
        let mut output_commitments = vector::empty<vector<u8>>();

        // 8. Insert transfer commitment into Merkle tree (for recipient)
        let position = merkle_tree::get_next_index(&pool.merkle_tree);
        merkle_tree::insert(&mut pool.merkle_tree, recipient_commitment);
        vector::push_back(&mut output_notes, encrypted_notes[0]);
        vector::push_back(&mut output_positions, position);
        vector::push_back(&mut output_commitments, recipient_commitment);

        // 9. Insert change commitment into Merkle tree (back to sender) if not zero
        if (!is_zero_commitment(&change_commitment)) {
            let position = merkle_tree::get_next_index(&pool.merkle_tree);
            merkle_tree::insert(&mut pool.merkle_tree, change_commitment);
            vector::push_back(&mut output_notes, encrypted_notes[1]);
            vector::push_back(&mut output_positions, position);
            vector::push_back(&mut output_commitments, change_commitment);
        };

        // 10. Emit event for wallet scanning
        event::emit(TransferEvent {
            pool_id: object::id(pool),
            input_nullifiers: used_nullifiers,
            output_positions,
            output_commitments,
            output_notes,
        });
    }

    /// Execute private swap through external DEX (Production Version)
    ///
    /// This function enables private swaps through DeepBook V3 while maintaining privacy.
    /// Users prove ownership of input notes via ZK proof, swap through DEX at market price,
    /// and receive output as a new private note.
    ///
    /// Nullifiers are passed explicitly (not embedded in public inputs) to keep them private.
    /// The circuit commits to them via nullifiers_hash = Poseidon(nullifier1, nullifier2),
    /// which the contract verifies on-chain using sui::poseidon::poseidon_bn254.
    ///
    /// Public inputs format (256 bytes, 8 field elements):
    /// [nullifiers_hash, swap_commitment, change_commitment, token_in, token_out, amount_in, amount_out, merkle_root]
    ///
    /// Flow:
    /// 1. Verify nullifiers match nullifiers_hash from proof (Poseidon commitment)
    /// 2. Verify merkle root validity
    /// 3. Check nullifiers not spent (double-spend prevention)
    /// 4. Verify Groth16 ZK proof
    /// 5. Execute swap via DeepBook V3
    /// 6. Shield output and change notes
    ///
    /// # Arguments
    /// * `pool_in` - Privacy pool for input token
    /// * `pool_out` - Privacy pool for output token
    /// * `deepbook_pool` - DeepBook pool for swapping
    /// * `proof_bytes` - Groth16 proof (128 bytes)
    /// * `public_inputs_bytes` - Public inputs (256 bytes, 8 field elements)
    /// * `nullifiers` - Explicit nullifiers [nullifier1, nullifier2] (each 32 bytes LE)
    /// * `min_amount_out` - Minimum output (slippage protection)
    /// * `deep_in` - DEEP tokens for DeepBook fees
    /// * `clock` - Clock object for timing
    /// * `encrypted_output_note` - Encrypted note for recipient
    /// * `encrypted_change_note` - Encrypted change note
    /// * `ctx` - Transaction context
    public fun swap<TokenIn, TokenOut>(
        pool_in: &mut PrivacyPool<TokenIn>,
        pool_out: &mut PrivacyPool<TokenOut>,
        deepbook_pool: &mut DeepBookPool<TokenIn, TokenOut>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        nullifiers: vector<vector<u8>>,
        deep_in: Coin<DEEP>,
        clock: &Clock,
        encrypted_output_note: vector<u8>,
        encrypted_change_note: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // Validate public inputs length (8 field elements × 32 bytes = 256 bytes)
        assert!(vector::length(&public_inputs_bytes) == 256, E_INVALID_PUBLIC_INPUTS);
        assert!(vector::length(&nullifiers) == 2, E_INVALID_PUBLIC_INPUTS);

        // 1. Parse public inputs [nullifiers_hash, swap_commitment, change_commitment, token_in, token_out, amount_in, min_amount_out, merkle_root]
        let (nullifiers_hash, swap_commitment, change_commitment, _token_in, _token_out, amount_in_bytes, min_amount_out_bytes, merkle_root) =
            parse_swap_public_inputs(&public_inputs_bytes);

        // Extract min_amount_out directly from the verified public inputs
        let min_amount_out: u64 = field_element_to_u64(&min_amount_out_bytes);

        let nullifier1 = *vector::borrow(&nullifiers, 0);
        let nullifier2 = *vector::borrow(&nullifiers, 1);

        // 2. Verify the explicitly-passed nullifiers match the nullifiers_hash in the proof
        // nullifiers_hash = Poseidon(nullifier1, nullifier2) as committed in the circuit
        let n1_u256 = field_element_to_u256(&nullifier1);
        let n2_u256 = field_element_to_u256(&nullifier2);
        let computed_hash = poseidon::poseidon_bn254(&vector[n1_u256, n2_u256]);
        let computed_hash_bytes = u256_to_field_element(computed_hash);
        assert!(computed_hash_bytes == nullifiers_hash, E_INVALID_PUBLIC_INPUTS);

        // 3. Verify merkle root is valid (current or in history)
        assert!(is_valid_root(pool_in, &merkle_root), E_INVALID_ROOT);

        // 4. Check both nullifiers have not been spent (prevent double-spend)
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier2), E_DOUBLE_SPEND);

        // 5. Verify Groth16 ZK proof
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &pool_in.swap_vk_bytes);
        let public_inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        let proof_points = groth16::proof_points_from_bytes(proof_bytes);

        assert!(
            groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &public_inputs, &proof_points),
            E_INVALID_PROOF
        );

        // 5. Execute swap through DeepBook V3
        let amount_in: u64 = field_element_to_u64(&amount_in_bytes);
        assert!(balance::value(&pool_in.balance) >= amount_in, E_INSUFFICIENT_BALANCE);
        let coin_in = coin::take(&mut pool_in.balance, amount_in, ctx);

        // Call DeepBook swap (TokenIn -> TokenOut)
        // This assumes TokenIn is the base token and TokenOut is the quote token
        let (base_out, quote_out, deep_out) = pool::swap_exact_base_for_quote(
            deepbook_pool,
            coin_in,
            deep_in,
            min_amount_out,
            clock,
            ctx
        );

        // base_out contains any unswapped remainder (partial fills possible)
        // quote_out is the received output token
        let amount_out = coin::value(&quote_out);
        assert!(amount_out >= min_amount_out, E_PRICE_TOO_LOW);

        // Return any remaining base tokens to pool_in
        balance::join(&mut pool_in.balance, coin::into_balance(base_out));

        // Shield output tokens into pool_out
        balance::join(&mut pool_out.balance, coin::into_balance(quote_out));

        // Return unused DEEP tokens to sender
        transfer::public_transfer(deep_out, tx_context::sender(ctx));

        // 7. Mark both nullifiers as spent
        let mut used_nullifiers = vector::empty<vector<u8>>();
        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier1);
        vector::push_back(&mut used_nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) {
            nullifier::mark_spent(&mut pool_in.nullifiers, nullifier2);
            vector::push_back(&mut used_nullifiers, nullifier2);
        };

        // 8. Save current roots before inserting (so existing proofs remain valid)
        save_historical_root(pool_out);

        // 9. Insert swap commitment to pool_out Merkle tree
        let swap_position = merkle_tree::get_next_index(&pool_out.merkle_tree);
        merkle_tree::insert(&mut pool_out.merkle_tree, swap_commitment);

        // 10. Add change commitment to pool_in Merkle tree (only if not zero)
        if (!is_zero_commitment(&change_commitment)){
            // Save current root to history before inserting change
            save_historical_root(pool_in);

            // Get position before inserting (next_index is the position where leaf will be inserted)
            let change_position = merkle_tree::get_next_index(&pool_in.merkle_tree);

            // Insert change commitment into Merkle tree
            merkle_tree::insert(&mut pool_in.merkle_tree, change_commitment);

            // Emit shield event for change note (so user can scan it)
            event::emit(ShieldEvent {
                pool_id: object::id(pool_in),
                position: change_position,
                commitment: change_commitment,
                encrypted_note: encrypted_change_note,
            });
        };

        // 11. Emit event
        event::emit(SwapEvent {
            pool_in_id: object::id(pool_in),
            pool_out_id: object::id(pool_out),
            amount_in,
            amount_out,
            input_nullifiers: used_nullifiers,
            swap_position,
            swap_commitment,
            encrypted_output_note,
        });
    }

    /// Swap quote token for base token (bid direction: e.g. DBUSDC → SUI).
    /// Use this when the input token is the quote token in the DeepBook pair.
    /// Type parameters: <Base, Quote> matching the DeepBook pool's fixed order.
    /// * `pool_in`  - Privacy pool for the quote (input) token
    /// * `pool_out` - Privacy pool for the base (output) token
    /// * `deepbook_pool` - DeepBook pool (always <Base, Quote> regardless of direction)
    public fun swap_bid<Base, Quote>(
        pool_in: &mut PrivacyPool<Quote>,
        pool_out: &mut PrivacyPool<Base>,
        deepbook_pool: &mut DeepBookPool<Base, Quote>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        nullifiers: vector<vector<u8>>,
        deep_in: Coin<DEEP>,
        clock: &Clock,
        encrypted_output_note: vector<u8>,
        encrypted_change_note: vector<u8>,
        ctx: &mut TxContext,
    ) {
        assert!(vector::length(&public_inputs_bytes) == 256, E_INVALID_PUBLIC_INPUTS);
        assert!(vector::length(&nullifiers) == 2, E_INVALID_PUBLIC_INPUTS);

        let (nullifiers_hash, swap_commitment, change_commitment, _token_in, _token_out, amount_in_bytes, min_amount_out_bytes, merkle_root) =
            parse_swap_public_inputs(&public_inputs_bytes);

        let min_amount_out: u64 = field_element_to_u64(&min_amount_out_bytes);

        let nullifier1 = *vector::borrow(&nullifiers, 0);
        let nullifier2 = *vector::borrow(&nullifiers, 1);

        let n1_u256 = field_element_to_u256(&nullifier1);
        let n2_u256 = field_element_to_u256(&nullifier2);
        let computed_hash = poseidon::poseidon_bn254(&vector[n1_u256, n2_u256]);
        let computed_hash_bytes = u256_to_field_element(computed_hash);
        assert!(computed_hash_bytes == nullifiers_hash, E_INVALID_PUBLIC_INPUTS);

        assert!(is_valid_root(pool_in, &merkle_root), E_INVALID_ROOT);

        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier2), E_DOUBLE_SPEND);

        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &pool_in.swap_vk_bytes);
        let public_inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        let proof_points = groth16::proof_points_from_bytes(proof_bytes);
        assert!(
            groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &public_inputs, &proof_points),
            E_INVALID_PROOF
        );

        let amount_in: u64 = field_element_to_u64(&amount_in_bytes);
        assert!(balance::value(&pool_in.balance) >= amount_in, E_INSUFFICIENT_BALANCE);
        let coin_in = coin::take(&mut pool_in.balance, amount_in, ctx);

        // Bid: swap quote (coin_in) for base output
        let (base_out, quote_out, deep_out) = pool::swap_exact_quote_for_base(
            deepbook_pool,
            coin_in,
            deep_in,
            min_amount_out,
            clock,
            ctx
        );

        let amount_out = coin::value(&base_out);
        assert!(amount_out >= min_amount_out, E_PRICE_TOO_LOW);

        // Return any unswapped quote remainder to pool_in
        balance::join(&mut pool_in.balance, coin::into_balance(quote_out));

        // Shield base output into pool_out
        balance::join(&mut pool_out.balance, coin::into_balance(base_out));

        transfer::public_transfer(deep_out, tx_context::sender(ctx));

        let mut used_nullifiers = vector::empty<vector<u8>>();
        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier1);
        vector::push_back(&mut used_nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) {
            nullifier::mark_spent(&mut pool_in.nullifiers, nullifier2);
            vector::push_back(&mut used_nullifiers, nullifier2);
        };

        save_historical_root(pool_out);
        let swap_position = merkle_tree::get_next_index(&pool_out.merkle_tree);
        merkle_tree::insert(&mut pool_out.merkle_tree, swap_commitment);

        if (!is_zero_commitment(&change_commitment)) {
            save_historical_root(pool_in);
            let change_position = merkle_tree::get_next_index(&pool_in.merkle_tree);
            merkle_tree::insert(&mut pool_in.merkle_tree, change_commitment);
            event::emit(ShieldEvent {
                pool_id: object::id(pool_in),
                position: change_position,
                commitment: change_commitment,
                encrypted_note: encrypted_change_note,
            });
        };

        event::emit(SwapEvent {
            pool_in_id: object::id(pool_in),
            pool_out_id: object::id(pool_out),
            amount_in,
            amount_out,
            input_nullifiers: used_nullifiers,
            swap_position,
            swap_commitment,
            encrypted_output_note,
        });
    }

    // ============ View Functions ============

    /// Get the current Merkle root
    public fun get_merkle_root<T>(pool: &PrivacyPool<T>): vector<u8> {
        merkle_tree::get_root(&pool.merkle_tree)
    }

    /// Get the number of notes in the pool
    public fun get_note_count<T>(pool: &PrivacyPool<T>): u64 {
        merkle_tree::get_next_index(&pool.merkle_tree)
    }

    /// Get the total shielded balance
    public fun get_balance<T>(pool: &PrivacyPool<T>): u64 {
        balance::value(&pool.balance)
    }

    /// Check if a nullifier has been spent
    public fun is_nullifier_spent<T>(pool: &PrivacyPool<T>, nullifier: vector<u8>): bool {
        nullifier::is_spent(&pool.nullifiers, nullifier)
    }

    // ============ Internal Functions ============

    /// Assert that the admin cap controls this pool
    fun assert_admin_cap<T>(pool: &PrivacyPool<T>, admin_cap: &PoolAdminCap) {
        assert!(admin_cap.pool_id == object::id(pool), E_INVALID_PROOF);
    }

    /// Extract a 32-byte field element from a byte vector at the given offset
    fun extract_field(bytes: &vector<u8>, offset: u64): vector<u8> {
        let mut field = vector::empty<u8>();
        let mut i = offset;
        while (i < offset + 32) {
            vector::push_back(&mut field, *vector::borrow(bytes, i));
            i = i + 1;
        };
        field
    }

    /// Save the current root to historical roots using a circular buffer (O(1))
    fun save_historical_root<T>(pool: &mut PrivacyPool<T>) {
        let root = merkle_tree::get_root(&pool.merkle_tree);
        let len = vector::length(&pool.historical_roots);
        if (len < ROOT_HISTORY_SIZE) {
            // Growing phase: append until the buffer is full
            vector::push_back(&mut pool.historical_roots, root);
        } else {
            // Full: overwrite the oldest slot in-place
            *vector::borrow_mut(&mut pool.historical_roots, pool.root_head) = root;
            pool.root_head = (pool.root_head + 1) % ROOT_HISTORY_SIZE;
        };
    }

    /// Check if a root is valid (current or in history)
    fun is_valid_root<T>(pool: &PrivacyPool<T>, root: &vector<u8>): bool {
        // Check current root
        if (*root == merkle_tree::get_root(&pool.merkle_tree)) {
            return true
        };

        // Check historical roots
        let len = vector::length(&pool.historical_roots);
        let mut i = 0;
        while (i < len) {
            if (*root == *vector::borrow(&pool.historical_roots, i)) {
                return true
            };
            i = i + 1;
        };

        false
    }

    /// Check if a commitment is zero (all bytes are 0)
    fun is_zero_commitment(commitment: &vector<u8>): bool {
        let len = vector::length(commitment);
        let mut i = 0;
        while (i < len) {
            if (*vector::borrow(commitment, i) != 0u8) {
                return false
            };
            i = i + 1;
        };
        true
    }

    /// Parse unshield public inputs from concatenated bytes.
    /// Returns (nullifiers_hash, change_commitment, recipient_hash, unshield_amount, token, merkle_root) each as 32-byte vectors.
    fun parse_unshield_public_inputs(bytes: &vector<u8>): (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {
        (
            extract_field(bytes, 0),    // nullifiers_hash
            extract_field(bytes, 32),   // change_commitment
            extract_field(bytes, 64),   // recipient_hash
            extract_field(bytes, 96),   // unshield_amount
            extract_field(bytes, 128),  // token
            extract_field(bytes, 160),  // merkle_root
        )
    }

    /// Compute Poseidon(addr_lo, addr_hi) for a Sui recipient address.
    /// Splits the 32-byte address into two 128-bit LE halves to avoid BN254 field overflow.
    /// Mirrors the circuit's recipient_hash computation and the SDK's recipientToFieldElements().
    fun compute_recipient_hash(recipient: address): vector<u8> {
        use sui::bcs;

        let addr_bytes = bcs::to_bytes(&recipient);

        // lo: bytes[0..16] as LE u128 → pad to 32 bytes → decode as LE u256
        let mut lo_buf = vector::empty<u8>();
        let mut i = 0u64;
        while (i < 16) {
            vector::push_back(&mut lo_buf, *vector::borrow(&addr_bytes, i));
            i = i + 1;
        };
        while (vector::length(&lo_buf) < 32) {
            vector::push_back(&mut lo_buf, 0u8);
        };
        let lo_u256 = { let mut b = bcs::new(lo_buf); bcs::peel_u256(&mut b) };

        // hi: bytes[16..32] as LE u128 → pad to 32 bytes → decode as LE u256
        let mut hi_buf = vector::empty<u8>();
        let mut j = 16u64;
        while (j < 32) {
            vector::push_back(&mut hi_buf, *vector::borrow(&addr_bytes, j));
            j = j + 1;
        };
        while (vector::length(&hi_buf) < 32) {
            vector::push_back(&mut hi_buf, 0u8);
        };
        let hi_u256 = { let mut b = bcs::new(hi_buf); bcs::peel_u256(&mut b) };

        u256_to_field_element(poseidon::poseidon_bn254(&vector[lo_u256, hi_u256]))
    }

    /// Parse transfer public inputs from concatenated bytes (for transfer).
    /// Returns (nullifiers_hash, recipient_commitment, change_commitment, token, merkle_root) each as 32-byte vectors.
    fun parse_transfer_public_inputs(bytes: &vector<u8>): (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {
        (
            extract_field(bytes, 0),    // nullifiers_hash
            extract_field(bytes, 32),   // recipient_commitment
            extract_field(bytes, 64),   // change_commitment
            extract_field(bytes, 96),   // token
            extract_field(bytes, 128),  // merkle_root
        )
    }

    /// Parse swap public inputs from concatenated bytes (for swap).
    /// Returns (nullifiers_hash, swap_commitment, change_commitment, token_in, token_out, amount_in, min_amount_out, merkle_root) each as 32-byte vectors.
    fun parse_swap_public_inputs(bytes: &vector<u8>): (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {
        (
            extract_field(bytes, 0),    // nullifiers_hash
            extract_field(bytes, 32),   // swap_commitment
            extract_field(bytes, 64),   // change_commitment
            extract_field(bytes, 96),   // token_in
            extract_field(bytes, 128),  // token_out
            extract_field(bytes, 160),  // amount_in
            extract_field(bytes, 192),  // amount_out
            extract_field(bytes, 224),  // merkle_root
        )
    }

    /// Convert 32-byte field element to u64
    /// Takes the least significant 8 bytes and converts to u64 (little-endian)
    fun field_element_to_u64(bytes: &vector<u8>): u64 {
        use sui::bcs;
        
        let mut b = bcs::new(*bytes);
        bcs::peel_u64(&mut b)
    }

    /// Convert a 32-byte little-endian field element to u256
    fun field_element_to_u256(bytes: &vector<u8>): u256 {
        use sui::bcs;
        let mut b = bcs::new(*bytes);
        bcs::peel_u256(&mut b)
    }

    /// Convert a u256 to a 32-byte little-endian field element
    fun u256_to_field_element(value: u256): vector<u8> {
        use sui::bcs;
        bcs::to_bytes(&value)
    }

    // ============ Test Helpers ============

    /// Expose compute_recipient_hash for use in tests that need to construct valid public inputs.
    #[test_only]
    public fun compute_recipient_hash_for_testing(recipient: address): vector<u8> {
        compute_recipient_hash(recipient)
    }

    /// Swap for testing only: skips proof verification and uses a 1:1 mock swap.
    /// Public inputs format (256 bytes): [token_in, token_out, merkle_root, nullifier1, nullifier2, swap_data_hash, output_commitment, change_commitment]
    #[test_only]
    public fun swap_for_testing<TokenIn, TokenOut>(
        pool_in: &mut PrivacyPool<TokenIn>,
        pool_out: &mut PrivacyPool<TokenOut>,
        _proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        amount_in: u64,
        min_amount_out: u64,
        deep_in: Coin<DEEP>,
        _clock: &Clock,
        encrypted_output_note: vector<u8>,
        encrypted_change_note: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // Validate public inputs length (8 field elements × 32 bytes = 256 bytes)
        assert!(vector::length(&public_inputs_bytes) == 256, E_INVALID_PUBLIC_INPUTS);

        // Parse public inputs: [token_in(32), token_out(32), root(32), nullifier1(32), nullifier2(32), swap_data_hash(32), output_commitment(32), change_commitment(32)]
        let merkle_root = extract_field(&public_inputs_bytes, 64);
        let nullifier1 = extract_field(&public_inputs_bytes, 96);
        let nullifier2 = extract_field(&public_inputs_bytes, 128);
        let output_commitment = extract_field(&public_inputs_bytes, 192);
        let change_commitment = extract_field(&public_inputs_bytes, 224);

        // Check merkle root is valid
        assert!(is_valid_root(pool_in, &merkle_root), E_INVALID_ROOT);

        // Check nullifiers not spent
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier2), E_DOUBLE_SPEND);

        // Check sufficient balance
        assert!(balance::value(&pool_in.balance) >= amount_in, E_INSUFFICIENT_BALANCE);

        // Mock 1:1 swap: remove amount_in from pool_in, add amount_in to pool_out
        let coin_in = coin::take(&mut pool_in.balance, amount_in, ctx);
        coin::burn_for_testing(coin_in);

        let amount_out = amount_in;
        assert!(amount_out >= min_amount_out, E_PRICE_TOO_LOW);
        balance::join(&mut pool_out.balance, balance::create_for_testing<TokenOut>(amount_out));

        // Destroy DEEP (unused in mock)
        coin::burn_for_testing(deep_in);

        // Mark nullifiers spent (skip dummy zero nullifier2)
        let mut used_nullifiers = vector::empty<vector<u8>>();
        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier1);
        vector::push_back(&mut used_nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) {
            nullifier::mark_spent(&mut pool_in.nullifiers, nullifier2);
            vector::push_back(&mut used_nullifiers, nullifier2);
        };

        // Insert output commitment into pool_out
        save_historical_root(pool_out);
        let swap_position = merkle_tree::get_next_index(&pool_out.merkle_tree);
        merkle_tree::insert(&mut pool_out.merkle_tree, output_commitment);

        // Insert change commitment into pool_in (only if non-zero)
        if (!is_zero_commitment(&change_commitment)) {
            save_historical_root(pool_in);
            let change_position = merkle_tree::get_next_index(&pool_in.merkle_tree);
            merkle_tree::insert(&mut pool_in.merkle_tree, change_commitment);
            event::emit(ShieldEvent {
                pool_id: object::id(pool_in),
                position: change_position,
                commitment: change_commitment,
                encrypted_note: encrypted_change_note,
            });
        };

        event::emit(SwapEvent {
            pool_in_id: object::id(pool_in),
            pool_out_id: object::id(pool_out),
            amount_in,
            amount_out,
            input_nullifiers: used_nullifiers,
            swap_position,
            swap_commitment: output_commitment,
            encrypted_output_note,
        });
    }

    #[test_only]
    public fun destroy_for_testing<T>(pool: PrivacyPool<T>) {
        let PrivacyPool {
            id,
            balance,
            merkle_tree,
            nullifiers,
            vk_bytes: _,
            transfer_vk_bytes: _,
            swap_vk_bytes: _,
            historical_roots: _,
            root_head: _,
        } = pool;

        balance::destroy_for_testing(balance);
        merkle_tree::destroy_for_testing(merkle_tree);
        nullifier::destroy_for_testing(nullifiers);
        object::delete(id);
    }
}
