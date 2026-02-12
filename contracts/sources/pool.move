/// Privacy Pool for Octopus on Sui
/// Implements shield (deposit) and unshield (withdraw with ZK proof) functionality
module octopus::pool {
    use sui::balance::{Self, Balance};
    use sui::coin::{Self, Coin};
    use sui::groth16;
    use sui::event;
    use sui::clock::Clock;
    use octopus::merkle_tree::{Self, MerkleTree};
    use octopus::nullifier::{Self, NullifierRegistry};
    use octopus::swap;

    // DeepBook V3 integration
    use deepbook::pool::{Pool as DeepBookPool};
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
        /// Change commitment (0 if no change)
        change_commitment: vector<u8>,
        /// Position of change commitment in Merkle tree (0 if no change)
        change_position: u64,
    }

    /// Event emitted when tokens are transferred privately within the pool
    public struct TransferEvent has copy, drop {
        /// Pool ID where the transfer occurred
        pool_id: ID,
        /// Nullifiers that were spent (2 inputs)
        input_nullifiers: vector<vector<u8>>,
        /// New commitments created (2 outputs)
        output_commitments: vector<vector<u8>>,
        /// Positions of output commitments in tree
        output_positions: vector<u64>,
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
        /// Nullifiers that were spent (2 inputs)
        input_nullifiers: vector<vector<u8>>,
        /// Output commitment (swapped token)
        output_commitment: vector<u8>,
        /// Change commitment (remaining input token)
        change_commitment: vector<u8>,
        /// Position of output commitment in output pool tree
        output_position: u64,
        /// Position of change commitment in input pool tree
        change_position: u64,
        /// Amount swapped in
        amount_in: u64,
        /// Amount received out
        amount_out: u64,
        /// Encrypted notes for recipient to scan
        encrypted_output_note: vector<u8>,
        encrypted_change_note: vector<u8>,
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
        assert!(admin_cap.pool_id == object::id(pool), E_INVALID_PROOF);
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
        assert!(admin_cap.pool_id == object::id(pool), E_INVALID_PROOF);
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
        assert!(admin_cap.pool_id == object::id(pool), E_INVALID_PROOF);
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
    ///
    /// Public signals format (192 bytes total):
    /// Public outputs (computed by circuit):
    /// - input_nullifiers[0] (32 bytes): First nullifier
    /// - input_nullifiers[1] (32 bytes): Second nullifier (0 if dummy note)
    /// - change_commitment (32 bytes): Commitment for change note (0 if no change)
    /// Public inputs (provided by user):
    /// - unshield_amount (32 bytes): Amount to withdraw (as field element)
    /// - token (32 bytes): Token type identifier
    /// - merkle_root (32 bytes): Merkle tree root
    public fun unshield<T>(
        pool: &mut PrivacyPool<T>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        recipient: address,
        encrypted_change_note: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // Validate public inputs length (6 field elements × 32 bytes = 192 bytes)
        assert!(vector::length(&public_inputs_bytes) == 192, E_INVALID_PUBLIC_INPUTS);

        // 1. Parse public inputs [input_nullifiers[2], change_commitment, unshield_amount, token, merkle_root]
        let (nullifier1, nullifier2, change_commitment, unshield_amount_bytes, _token, merkle_root) =
            parse_unshield_public_inputs(&public_inputs_bytes);

        // 2. Convert unshield_amount from field element to u64
        let amount = field_element_to_u64(&unshield_amount_bytes);

        // 3. Verify merkle root is valid (current or in history)
        assert!(is_valid_root(pool, &merkle_root), E_INVALID_ROOT);

        // 4. Check both nullifiers have not been spent (prevent double-spend)
        assert!(!nullifier::is_spent(&pool.nullifiers, nullifier1), E_DOUBLE_SPEND);
        if (!is_zero_commitment(&nullifier2)) {
            assert!(!nullifier::is_spent(&pool.nullifiers, nullifier2), E_DOUBLE_SPEND);
        };

        // 5. Verify Groth16 ZK proof
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &pool.vk_bytes);
        let public_inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        let proof_points = groth16::proof_points_from_bytes(proof_bytes);

        assert!(
            groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &public_inputs, &proof_points),
            E_INVALID_PROOF
        );

        // 6. Mark nullifiers as spent
        nullifier::mark_spent(&mut pool.nullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) {
            nullifier::mark_spent(&mut pool.nullifiers, nullifier2);
        };

        // 7. Transfer tokens to recipient
        assert!(balance::value(&pool.balance) >= amount, E_INSUFFICIENT_BALANCE);
        let withdrawn = coin::take(&mut pool.balance, amount, ctx);
        transfer::public_transfer(withdrawn, recipient);

        // 8. Handle change note (if any)
        let mut change_position = 0u64;
        if (!is_zero_commitment(&change_commitment)) {
            // Save current root to history before inserting change
            save_historical_root(pool);

            // Get position before inserting (next_index is the position where leaf will be inserted)
            change_position = merkle_tree::get_next_index(&pool.merkle_tree);

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
            change_commitment,
            change_position,
        });
    }

    /// Transfer tokens privately within the pool (0zk-to-0zk transfer).
    ///
    /// The ZK proof proves:
    /// 1. Knowledge of spending_key and nullifying_key (ownership of both inputs)
    /// 2. Both input notes exist in Merkle tree (2 Merkle proofs)
    /// 3. Correct nullifier computation for both inputs
    /// 4. Correct commitment computation for transfer and change outputs
    /// 5. Balance conservation: sum(input_amounts) = transfer_amount + change_amount
    ///
    /// Public inputs format (192 bytes total):
    /// - token (32 bytes): Token type identifier
    /// - merkle_root (32 bytes): Merkle tree root
    /// - input_nullifiers[2] (64 bytes): Nullifiers for both input notes
    /// - transfer_commitment (32 bytes): Commitment for transfer to recipient
    /// - change_commitment (32 bytes): Commitment for change back to sender
    public fun transfer<T>(
        pool: &mut PrivacyPool<T>,
        proof_bytes: vector<u8>,
        public_inputs_bytes: vector<u8>,
        encrypted_notes: vector<vector<u8>>,
        _ctx: &mut TxContext,
    ) {
        // Validate public inputs length (6 field elements × 32 bytes = 192 bytes)
        assert!(vector::length(&public_inputs_bytes) == 192, E_INVALID_PUBLIC_INPUTS);
        assert!(vector::length(&encrypted_notes) == 2, E_INVALID_PUBLIC_INPUTS);

        // 1. Parse public inputs [nullifier1, nullifier2, transfer_commitment, change_commitment, token, merkle_root]
        let (nullifier1, nullifier2, transfer_commitment, change_commitment, _token, merkle_root) =
            parse_transfer_public_inputs(&public_inputs_bytes);

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
        let mut usedNullifiers = vector::empty<vector<u8>>();
        nullifier::mark_spent(&mut pool.nullifiers, nullifier1);
        vector::push_back(&mut usedNullifiers, nullifier1);
        if (!is_zero_commitment(&nullifier2)) { // not dummy commit
            nullifier::mark_spent(&mut pool.nullifiers, nullifier2);
            vector::push_back(&mut usedNullifiers, nullifier2);
        };

        // 6. Save current root before inserting (so existing proofs remain valid)
        save_historical_root(pool);

        // 7. Build output vectors for non-zero commitments
        let mut output_notes: vector<vector<u8>> = vector::empty<vector<u8>>();
        let mut output_commitments = vector::empty<vector<u8>>();
        let mut output_positions = vector::empty<u64>();

        // 8. Insert transfer commitment into Merkle tree (for recipient)
        let position = merkle_tree::get_next_index(&pool.merkle_tree);
        merkle_tree::insert(&mut pool.merkle_tree, transfer_commitment);
        vector::push_back(&mut output_notes, encrypted_notes[0]);
        vector::push_back(&mut output_commitments, transfer_commitment);
        vector::push_back(&mut output_positions, position);


        // 9. Insert change commitment into Merkle tree (back to sender) if not zero
        if (!is_zero_commitment(&change_commitment)) {
            let position = merkle_tree::get_next_index(&pool.merkle_tree);
            merkle_tree::insert(&mut pool.merkle_tree, change_commitment);
            vector::push_back(&mut output_notes, encrypted_notes[1]);
            vector::push_back(&mut output_commitments, change_commitment);
            vector::push_back(&mut output_positions, position);
        };

        // 10. Emit event for wallet scanning
        event::emit(TransferEvent {
            pool_id: object::id(pool),
            input_nullifiers: usedNullifiers,
            output_commitments,
            output_positions,
            output_notes,
        });
    }

    /// Execute private swap through external DEX (Production Version)
    ///
    /// This function enables private swaps through DeepBook V3 while maintaining privacy.
    /// Users prove ownership of input notes via ZK proof, swap through DEX at market price,
    /// and receive output as a new private note.
    ///
    /// Flow:
    /// 1. Verify ZK proof (proves ownership of input notes and swap parameters)
    /// 2. Extract input tokens from pool_in
    /// 3. Call external DEX (DeepBook V3) to execute swap
    /// 4. Shield output tokens into pool_out
    /// 5. Return change to pool_in if applicable
    ///
    /// # Arguments
    /// * `pool_in` - Privacy pool for input token
    /// * `pool_out` - Privacy pool for output token
    /// * `deepbook_pool` - DeepBook pool for swapping
    /// * `proof_bytes` - Groth16 proof (128 bytes)
    /// * `public_inputs_bytes` - Public inputs (256 bytes)
    /// * `amount_in` - Exact amount to swap
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
        amount_in: u64,
        min_amount_out: u64,
        deep_in: Coin<DEEP>,
        clock: &Clock,
        encrypted_output_note: vector<u8>,
        encrypted_change_note: vector<u8>,
        ctx: &mut TxContext,
    ) {
        // Validate public inputs length (8 field elements × 32 bytes = 256 bytes)
        assert!(vector::length(&public_inputs_bytes) == 256, E_INVALID_PUBLIC_INPUTS);

        // 0. Validate amount_in is greater than zero
        assert!(amount_in > 0, E_ZERO_AMOUNT);

        // 1. Parse public inputs
        let (_token_in, _token_out, merkle_root, nullifier1, nullifier2, _swap_data_hash, output_commitment, change_commitment) =
            parse_swap_public_inputs(&public_inputs_bytes);

        // 2. Verify merkle root is valid (current or in history)
        assert!(is_valid_root(pool_in, &merkle_root), E_INVALID_ROOT);

        // 3. Check both nullifiers have not been spent (prevent double-spend)
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier2), E_DOUBLE_SPEND);

        // 4. Verify Groth16 ZK proof using swap verification key
        let pvk = groth16::prepare_verifying_key(&groth16::bn254(), &pool_in.swap_vk_bytes);
        let public_inputs = groth16::public_proof_inputs_from_bytes(public_inputs_bytes);
        let proof_points = groth16::proof_points_from_bytes(proof_bytes);

        assert!(
            groth16::verify_groth16_proof(&groth16::bn254(), &pvk, &public_inputs, &proof_points),
            E_INVALID_PROOF
        );

        // 5. Execute swap through DeepBook V3
        assert!(balance::value(&pool_in.balance) >= amount_in, E_INSUFFICIENT_BALANCE);
        let coin_in = coin::take(&mut pool_in.balance, amount_in, ctx);

        // Call DeepBook swap (TokenIn -> TokenOut)
        // This assumes TokenIn is the base token and TokenOut is the quote token
        let (base_out, quote_out, deep_out) = swap::execute_swap_base_for_quote(
            deepbook_pool,
            coin_in,
            deep_in,
            min_amount_out,
            clock,
            ctx
        );

        // base_out should be empty (all input swapped)
        // quote_out is the received output token
        let amount_out = coin::value(&quote_out);

        // Return any remaining base tokens to pool_in
        balance::join(&mut pool_in.balance, coin::into_balance(base_out));

        // Shield output tokens into pool_out
        balance::join(&mut pool_out.balance, coin::into_balance(quote_out));

        // Return unused DEEP tokens to sender
        transfer::public_transfer(deep_out, tx_context::sender(ctx));

        // 7. Verify slippage protection
        assert!(amount_out >= min_amount_out, E_PRICE_TOO_LOW);

        // 8. Mark both nullifiers as spent
        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier1);
        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier2);

        // 9. Save current roots before inserting (so existing proofs remain valid)
        save_historical_root(pool_in);
        save_historical_root(pool_out);

        // 10. Add output commitment to pool_out Merkle tree
        let output_position = merkle_tree::get_next_index(&pool_out.merkle_tree);
        merkle_tree::insert(&mut pool_out.merkle_tree, output_commitment);

        // 11. Add change commitment to pool_in Merkle tree (only if not zero)
        let change_position = if (!is_zero_commitment(&change_commitment)) {
            let position = merkle_tree::get_next_index(&pool_in.merkle_tree);
            merkle_tree::insert(&mut pool_in.merkle_tree, change_commitment);
            position
        } else {
            // Use a sentinel value for zero commitment (not inserted into tree)
            0
        };

        // 12. Emit event for wallet scanning
        event::emit(SwapEvent {
            pool_in_id: object::id(pool_in),
            pool_out_id: object::id(pool_out),
            input_nullifiers: vector[nullifier1, nullifier2],
            output_commitment: output_commitment,
            change_commitment: change_commitment,
            output_position,
            change_position,
            amount_in,
            amount_out,
            encrypted_output_note: encrypted_output_note,
            encrypted_change_note: encrypted_change_note,
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

    /// Save the current root to historical roots
    fun save_historical_root<T>(pool: &mut PrivacyPool<T>) {
        let root = merkle_tree::get_root(&pool.merkle_tree);
        vector::push_back(&mut pool.historical_roots, root);

        // Keep only last ROOT_HISTORY_SIZE roots
        while (vector::length(&pool.historical_roots) > ROOT_HISTORY_SIZE) {
            vector::remove(&mut pool.historical_roots, 0);
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

    /// Parse unshield public inputs from concatenated bytes (for unshield with 2-input support).
    /// Returns (nullifier1, nullifier2, change_commitment, unshield_amount, token, merkle_root) each as 32-byte vectors.
    ///
    /// Public signals from circuit (192 bytes total):
    /// Public outputs (computed by circuit):
    /// - input_nullifiers[0] (32 bytes): First nullifier
    /// - input_nullifiers[1] (32 bytes): Second nullifier (0 if dummy note)
    /// - change_commitment (32 bytes): Commitment for change note (0 if no change)
    /// Public inputs (provided by user):
    /// - unshield_amount (32 bytes): Amount to unshield (as field element)
    /// - token (32 bytes): Token type identifier
    /// - merkle_root (32 bytes): Merkle tree root
    fun parse_unshield_public_inputs(bytes: &vector<u8>): (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {
        let mut nullifier1 = vector::empty<u8>();
        let mut nullifier2 = vector::empty<u8>();
        let mut change_commitment = vector::empty<u8>();
        let mut unshield_amount_bytes = vector::empty<u8>();
        let mut token = vector::empty<u8>();
        let mut merkle_root = vector::empty<u8>();

        // Extract nullifier1 (bytes 0-31)
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut nullifier1, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract nullifier2 (bytes 32-63)
        while (i < 64) {
            vector::push_back(&mut nullifier2, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract change_commitment (bytes 64-95)
        while (i < 96) {
            vector::push_back(&mut change_commitment, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract unshield_amount (bytes 96-127)
        while (i < 128) {
            vector::push_back(&mut unshield_amount_bytes, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract token (bytes 128-159)
        while (i < 160) {
            vector::push_back(&mut token, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract merkle_root (bytes 160-191)
        while (i < 192) {
            vector::push_back(&mut merkle_root, *vector::borrow(bytes, i));
            i = i + 1;
        };

        (nullifier1, nullifier2, change_commitment, unshield_amount_bytes, token, merkle_root)
    }

    /// Convert 32-byte field element to u64
    /// Takes the least significant 8 bytes and converts to u64 (little-endian)
    fun field_element_to_u64(bytes: &vector<u8>): u64 {
        let mut result = 0u64;
        let mut multiplier = 1u64;

        // Take first 8 bytes (little-endian)
        let mut i = 0;
        while (i < 8) {
            let byte_val = (*vector::borrow(bytes, i) as u64);
            result = result + (byte_val * multiplier);
            // Only update multiplier if we haven't processed the last byte yet
            if (i < 7) {
                multiplier = multiplier * 256;
            };
            i = i + 1;
        };

        result
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

    /// Parse transfer public inputs from concatenated bytes (for transfer).
    /// Returns (token, merkle_root, nullifier1, nullifier2, transfer_commitment, change_commitment) each as 32-byte vectors.
    fun parse_transfer_public_inputs(bytes: &vector<u8>):
        (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {

        let mut token = vector::empty<u8>();
        let mut merkle_root = vector::empty<u8>();
        let mut nullifier1 = vector::empty<u8>();
        let mut nullifier2 = vector::empty<u8>();
        let mut transfer_commitment = vector::empty<u8>();
        let mut change_commitment = vector::empty<u8>();

        // Extract token (bytes 0-31)
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut token, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract merkle_root (bytes 32-63)
        while (i < 64) {
            vector::push_back(&mut merkle_root, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract nullifier1 (bytes 64-95)
        while (i < 96) {
            vector::push_back(&mut nullifier1, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract nullifier2 (bytes 96-127)
        while (i < 128) {
            vector::push_back(&mut nullifier2, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract transfer_commitment (bytes 128-159)
        while (i < 160) {
            vector::push_back(&mut transfer_commitment, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract change_commitment (bytes 160-191)
        while (i < 192) {
            vector::push_back(&mut change_commitment, *vector::borrow(bytes, i));
            i = i + 1;
        };

        (token, merkle_root, nullifier1, nullifier2, transfer_commitment, change_commitment)
    }

    /// Parse swap public inputs from concatenated bytes (for swap).
    /// Returns (token_in, token_out, merkle_root, nullifier1, nullifier2, swap_data_hash, output_commitment, change_commitment)
    /// each as 32-byte vectors.
    ///
    /// Public signal order (8 × 32 = 256 bytes):
    /// - Public inputs (token_in, token_out, merkle_root) come first
    /// - Public outputs (nullifiers, swap_data_hash, output_commitment, change_commitment) follow
    fun parse_swap_public_inputs(bytes: &vector<u8>):
        (vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>, vector<u8>) {

        let mut token_in = vector::empty<u8>();
        let mut token_out = vector::empty<u8>();
        let mut merkle_root = vector::empty<u8>();
        let mut nullifier1 = vector::empty<u8>();
        let mut nullifier2 = vector::empty<u8>();
        let mut swap_data_hash = vector::empty<u8>();
        let mut output_commitment = vector::empty<u8>();
        let mut change_commitment = vector::empty<u8>();

        // Extract token_in (bytes 0-31)
        let mut i = 0;
        while (i < 32) {
            vector::push_back(&mut token_in, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract token_out (bytes 32-63)
        while (i < 64) {
            vector::push_back(&mut token_out, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract merkle_root (bytes 64-95)
        while (i < 96) {
            vector::push_back(&mut merkle_root, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract nullifier1 (bytes 96-127)
        while (i < 128) {
            vector::push_back(&mut nullifier1, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract nullifier2 (bytes 128-159)
        while (i < 160) {
            vector::push_back(&mut nullifier2, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract swap_data_hash (bytes 160-191)
        while (i < 192) {
            vector::push_back(&mut swap_data_hash, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract output_commitment (bytes 192-223)
        while (i < 224) {
            vector::push_back(&mut output_commitment, *vector::borrow(bytes, i));
            i = i + 1;
        };

        // Extract change_commitment (bytes 224-255)
        while (i < 256) {
            vector::push_back(&mut change_commitment, *vector::borrow(bytes, i));
            i = i + 1;
        };

        (token_in, token_out, merkle_root, nullifier1, nullifier2, swap_data_hash, output_commitment, change_commitment)
    }

    /// Execute a mock swap (1:1 ratio) for testing.
    /// TODO: Replace with real DeepBook V3 integration.
    ///
    /// In production, this should:
    /// 1. Call DeepBook V3 place_market_order function
    /// 2. Get real market price from order book
    /// 3. Apply slippage protection
    /// 4. Return actual output amount
    #[test_only]
    fun execute_mock_swap<TokenIn, TokenOut>(
        coin_in: Coin<TokenIn>,
        min_amount_out: u64,
        pool_out: &mut PrivacyPool<TokenOut>,
        ctx: &mut TxContext,
    ): u64 {
        // Get input amount
        let amount_in = coin::value(&coin_in);

        // Destroy input coin (in real DEX integration, this would go to the DEX)
        coin::burn_for_testing(coin_in);

        // Mock 1:1 swap (simplified for testing)
        // In production, this would call:
        // let (coin_out, _) = deepbook::place_market_order<TokenIn, TokenOut>(pool, true, amount_in, coin_in, ...);
        let amount_out = amount_in; // 1:1 ratio for testing

        // Check slippage protection
        assert!(amount_out >= min_amount_out, E_INSUFFICIENT_BALANCE);

        // Mint output tokens (in real DEX integration, we'd receive from DEX)
        let coin_out = coin::mint_for_testing<TokenOut>(amount_out, ctx);

        // Add to output pool balance
        balance::join(&mut pool_out.balance, coin::into_balance(coin_out));

        amount_out
    }

    // ============ Test Helpers ============

    /// Test-only swap that skips ZK proof verification and DeepBook integration.
    /// Mirrors the production swap logic with a mock 1:1 exchange rate.
    #[test_only]
    public fun swap_for_testing<TokenIn, TokenOut>(
        pool_in: &mut PrivacyPool<TokenIn>,
        pool_out: &mut PrivacyPool<TokenOut>,
        proof_bytes: vector<u8>,
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
        assert!(amount_in > 0, E_ZERO_AMOUNT);

        // Return DEEP tokens to sender (not needed for mock swap)
        transfer::public_transfer(deep_in, tx_context::sender(ctx));

        let (_token_in, _token_out, merkle_root, nullifier1, nullifier2, _swap_data_hash, output_commitment, change_commitment) =
            parse_swap_public_inputs(&public_inputs_bytes);

        assert!(is_valid_root(pool_in, &merkle_root), E_INVALID_ROOT);
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier1), E_DOUBLE_SPEND);
        assert!(!nullifier::is_spent(&pool_in.nullifiers, nullifier2), E_DOUBLE_SPEND);

        // Skip proof verification — use execute_mock_swap instead of real DEX
        let _ = proof_bytes;
        assert!(balance::value(&pool_in.balance) >= amount_in, E_INSUFFICIENT_BALANCE);
        let amount_out = execute_mock_swap<TokenIn, TokenOut>(
            coin::take(&mut pool_in.balance, amount_in, ctx),
            min_amount_out,
            pool_out,
            ctx,
        );

        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier1);
        nullifier::mark_spent(&mut pool_in.nullifiers, nullifier2);

        save_historical_root(pool_in);
        save_historical_root(pool_out);

        let output_position = merkle_tree::get_next_index(&pool_out.merkle_tree);
        merkle_tree::insert(&mut pool_out.merkle_tree, output_commitment);

        // Add change commitment to pool_in Merkle tree (only if not zero)
        let change_position = if (!is_zero_commitment(&change_commitment)) {
            let position = merkle_tree::get_next_index(&pool_in.merkle_tree);
            merkle_tree::insert(&mut pool_in.merkle_tree, change_commitment);
            position
        } else {
            // Use a sentinel value for zero commitment (not inserted into tree)
            0
        };

        event::emit(SwapEvent {
            pool_in_id: object::id(pool_in),
            pool_out_id: object::id(pool_out),
            input_nullifiers: vector[nullifier1, nullifier2],
            output_commitment,
            change_commitment,
            output_position,
            change_position,
            amount_in,
            amount_out,
            encrypted_output_note,
            encrypted_change_note,
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
            historical_roots: _
        } = pool;

        balance::destroy_for_testing(balance);
        merkle_tree::destroy_for_testing(merkle_tree);
        nullifier::destroy_for_testing(nullifiers);
        object::delete(id);
    }
}
