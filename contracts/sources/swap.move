/// DeepBook v3 integration for swapping SUI/USDC
module octopus::swap {
    use sui::coin::{Self, Coin};
    use sui::clock::Clock;

    // DeepBook v3 imports
    use deepbook::pool::{Self, Pool};
    use token::deep::DEEP;

    /// Error codes
    const EInsufficientAmount: u64 = 1;

    /// Swap exact SUI for USDC
    ///
    /// # Arguments
    /// * `pool` - Mutable reference to the SUI/USDC pool
    /// * `sui_in` - SUI coins to swap
    /// * `deep_in` - DEEP tokens for fees
    /// * `min_usdc_out` - Minimum USDC expected (slippage protection)
    /// * `clock` - Clock object for timing
    /// * `ctx` - Transaction context
    ///
    /// Returns remaining SUI, USDC output, and unused DEEP to the sender
    public fun swap_sui_to_usdc<SUI, USDC>(
        pool: &mut Pool<SUI, USDC>,
        sui_in: Coin<SUI>,
        deep_in: Coin<DEEP>,
        min_usdc_out: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Verify non-zero input
        assert!(coin::value(&sui_in) > 0, EInsufficientAmount);

        // Execute swap through DeepBook
        let (sui_out, usdc_out, deep_out) = pool::swap_exact_base_for_quote(
            pool,
            sui_in,
            deep_in,
            min_usdc_out,
            clock,
            ctx
        );

        // Transfer all outputs to sender
        let sender = tx_context::sender(ctx);
        sui::transfer::public_transfer(sui_out, sender);
        sui::transfer::public_transfer(usdc_out, sender);
        sui::transfer::public_transfer(deep_out, sender);
    }

    /// Swap exact USDC for SUI
    ///
    /// # Arguments
    /// * `pool` - Mutable reference to the SUI/USDC pool
    /// * `usdc_in` - USDC coins to swap
    /// * `deep_in` - DEEP tokens for fees
    /// * `min_sui_out` - Minimum SUI expected (slippage protection)
    /// * `clock` - Clock object for timing
    /// * `ctx` - Transaction context
    ///
    /// Returns SUI output, remaining USDC, and unused DEEP to the sender
    public fun swap_usdc_to_sui<SUI, USDC>(
        pool: &mut Pool<SUI, USDC>,
        usdc_in: Coin<USDC>,
        deep_in: Coin<DEEP>,
        min_sui_out: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Verify non-zero input
        assert!(coin::value(&usdc_in) > 0, EInsufficientAmount);

        // Execute swap through DeepBook
        let (sui_out, usdc_out, deep_out) = pool::swap_exact_quote_for_base(
            pool,
            usdc_in,
            deep_in,
            min_sui_out,
            clock,
            ctx
        );

        // Transfer all outputs to sender
        let sender = tx_context::sender(ctx);
        sui::transfer::public_transfer(sui_out, sender);
        sui::transfer::public_transfer(usdc_out, sender);
        sui::transfer::public_transfer(deep_out, sender);
    }

    /// Generic swap function that accepts both SUI and USDC inputs
    /// Useful for more complex swap strategies
    ///
    /// # Arguments
    /// * `pool` - Mutable reference to the SUI/USDC pool
    /// * `sui_in` - SUI coins (can be zero value)
    /// * `usdc_in` - USDC coins (can be zero value)
    /// * `deep_in` - DEEP tokens for fees
    /// * `min_out` - Minimum output expected
    /// * `clock` - Clock object
    /// * `ctx` - Transaction context
    public fun swap_exact_quantity<SUI, USDC>(
        pool: &mut Pool<SUI, USDC>,
        sui_in: Coin<SUI>,
        usdc_in: Coin<USDC>,
        deep_in: Coin<DEEP>,
        min_out: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ) {
        // Execute swap
        let (sui_out, usdc_out, deep_out) = pool::swap_exact_quantity(
            pool,
            sui_in,
            usdc_in,
            deep_in,
            min_out,
            clock,
            ctx
        );

        // Transfer outputs
        let sender = tx_context::sender(ctx);
        sui::transfer::public_transfer(sui_out, sender);
        sui::transfer::public_transfer(usdc_out, sender);
        sui::transfer::public_transfer(deep_out, sender);
    }

    // ============ Helper Functions for Pool Integration ============

    /// Execute swap from base to quote token (e.g., SUI -> USDC)
    /// Returns (base_out, quote_out, deep_out) where:
    /// - base_out: remaining base token (usually zero for exact input)
    /// - quote_out: received quote token
    /// - deep_out: unused DEEP tokens
    public fun execute_swap_base_for_quote<BASE, QUOTE>(
        pool: &mut Pool<BASE, QUOTE>,
        base_in: Coin<BASE>,
        deep_in: Coin<DEEP>,
        min_quote_out: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): (Coin<BASE>, Coin<QUOTE>, Coin<DEEP>) {
        pool::swap_exact_base_for_quote(
            pool,
            base_in,
            deep_in,
            min_quote_out,
            clock,
            ctx
        )
    }

    /// Execute swap from quote to base token (e.g., USDC -> SUI)
    /// Returns (base_out, quote_out, deep_out) where:
    /// - base_out: received base token
    /// - quote_out: remaining quote token (usually zero for exact input)
    /// - deep_out: unused DEEP tokens
    public fun execute_swap_quote_for_base<BASE, QUOTE>(
        pool: &mut Pool<BASE, QUOTE>,
        quote_in: Coin<QUOTE>,
        deep_in: Coin<DEEP>,
        min_base_out: u64,
        clock: &Clock,
        ctx: &mut TxContext
    ): (Coin<BASE>, Coin<QUOTE>, Coin<DEEP>) {
        pool::swap_exact_quote_for_base(
            pool,
            quote_in,
            deep_in,
            min_base_out,
            clock,
            ctx
        )
    }

    #[test_only]
    public fun test_init(_ctx: &mut TxContext) {
        // Test initialization function
    }
}
