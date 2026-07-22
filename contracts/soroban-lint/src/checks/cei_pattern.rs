use std::path::Path;
use syn::{visit::Visit, *};

pub fn check(ast: &File, file_path: &Path) -> (u64, u64) {
    let mut visitor = CeiPatternVisitor::new(file_path);
    visitor.visit_file(ast);
    (visitor.warnings, visitor.errors)
}

struct CeiPatternVisitor<'a> {
    file_path: &'a Path,
    warnings: u64,
    errors: u64,
}

impl<'a> CeiPatternVisitor<'a> {
    fn new(file_path: &'a Path) -> Self { Self { file_path, warnings: 0, errors: 0 } }

    fn emit_warning(&mut self, fn_name: &str) {
        println!(
            "  ⚠  {}: function `{}` appears to have a CEI pattern violation:\n\
             │  storage writes found after external token transfer calls",
            self.file_path.display(), fn_name,
        );
        println!(
            "     │  The CEI pattern requires state updates BEFORE external\n\
               │  calls (like token transfers). Update contract state first,\n\
               │  then make external calls, to ensure clean rollback on failure."
        );
        self.warnings += 1;
    }
}

impl<'a> Visit<'_> for CeiPatternVisitor<'a> {
    fn visit_item_fn(&mut self, node: &ItemFn) {
        if !matches!(node.vis, Visibility::Public(_)) { return; }
        if node.attrs.iter().any(|a| is_test_attr(a)) { return; }
        self.check_block_for_cei(&node.sig.ident.to_string(), &node.block);
    }

    fn visit_impl_item_fn(&mut self, node: &ImplItemFn) {
        if !matches!(node.vis, Visibility::Public(_)) { return; }
        if node.attrs.iter().any(|a| is_test_attr(a)) { return; }
        self.check_block_for_cei(&node.sig.ident.to_string(), &node.block);
    }
}

impl CeiPatternVisitor<'_> {
    fn check_block_for_cei(&mut self, fn_name: &str, block: &Block) {
        let mut analyzer = CeiAnalyzer::default();
        analyzer.visit_block(block);

        if analyzer.has_transfer && analyzer.has_storage_after_transfer {
            self.emit_warning(fn_name);
        }
    }
}

#[derive(Default)]
struct CeiAnalyzer {
    has_transfer: bool,
    has_storage_after_transfer: bool,
    seen_first_transfer: bool,
}

impl<'a> Visit<'_> for CeiAnalyzer {
    fn visit_expr_method_call(&mut self, node: &ExprMethodCall) {
        if node.method == "transfer" {
            // Detect any .transfer() call as an external interaction.
            // In Soroban contracts, token transfers are the primary
            // external call that should follow CEI pattern.
            self.has_transfer = true;
            self.seen_first_transfer = true;
        }
        if node.method == "set" && is_persistent_chain(&node.receiver) {
            if self.seen_first_transfer {
                self.has_storage_after_transfer = true;
            }
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn is_persistent_chain(expr: &Expr) -> bool {
    matches!(expr, Expr::MethodCall(mc) if mc.method == "persistent")
}

fn is_test_attr(attr: &Attribute) -> bool {
    if let Meta::Path(p) = &attr.meta {
        p.is_ident("test") || p.is_ident("should_panic")
    } else { false }
}
