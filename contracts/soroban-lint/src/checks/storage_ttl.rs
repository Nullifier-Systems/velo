use std::path::Path;
use syn::{visit::Visit, *};

pub fn check(ast: &File, file_path: &Path) -> (u64, u64) {
    let mut visitor = StorageTtlVisitor::new(file_path);
    visitor.visit_file(ast);
    (visitor.warnings, visitor.errors)
}

struct StorageTtlVisitor<'a> {
    file_path: &'a Path,
    warnings: u64,
    errors: u64,
}

impl<'a> StorageTtlVisitor<'a> {
    fn new(file_path: &'a Path) -> Self {
        Self {
            file_path,
            warnings: 0,
            errors: 0,
        }
    }

    fn emit_warning(&mut self, fn_name: &str, key_expr: &str) {
        println!(
            "  ⚠  {}: function `{}` writes to persistent storage (key: {}) but never calls extend_ttl() on it",
            self.file_path.display(), fn_name, key_expr,
        );
        println!(
            "     │  Soroban persistent storage entries have finite TTL.\n\
               │  Without extend_ttl(), data may expire and cause the\n\
               │  contract to panic on subsequent reads."
        );
        self.warnings += 1;
    }
}

impl<'a> Visit<'_> for StorageTtlVisitor<'a> {
    fn visit_item_fn(&mut self, node: &ItemFn) {
        if !matches!(node.vis, Visibility::Public(_)) {
            return;
        }
        if node.attrs.iter().any(|a| is_test_attr(a)) {
            return;
        }
        self.check_block_for_ttl(&node.sig.ident.to_string(), &node.block);
    }

    fn visit_impl_item_fn(&mut self, node: &ImplItemFn) {
        if !matches!(node.vis, Visibility::Public(_)) {
            return;
        }
        if node.attrs.iter().any(|a| is_test_attr(a)) {
            return;
        }
        self.check_block_for_ttl(&node.sig.ident.to_string(), &node.block);
    }
}

impl StorageTtlVisitor<'_> {
    fn check_block_for_ttl(&mut self, fn_name: &str, block: &Block) {
        let mut set_finder = PersistentSetFinder::default();
        set_finder.visit_block(block);
        let set_keys = set_finder.keys;

        let mut ttl_finder = ExtendTtlFinder::default();
        ttl_finder.visit_block(block);
        let ttl_keys = ttl_finder.keys;

        for key_expr in &set_keys {
            let has_extend = ttl_keys.iter().any(|k| key_expressions_match(k, key_expr));
            if !has_extend {
                self.emit_warning(fn_name, key_expr);
            }
        }
    }
}

fn key_expressions_match(ttl_key: &str, set_key: &str) -> bool {
    if ttl_key == set_key {
        return true;
    }
    let ttl_parts: Vec<&str> = ttl_key
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .collect();
    let set_parts: Vec<&str> = set_key
        .split(|c: char| !c.is_alphanumeric() && c != '_')
        .collect();
    for tp in &ttl_parts {
        if tp.len() > 2 && set_parts.contains(tp) {
            return true;
        }
    }
    false
}

#[derive(Default)]
struct PersistentSetFinder {
    keys: Vec<String>,
}

impl<'a> Visit<'_> for PersistentSetFinder {
    fn visit_expr_method_call(&mut self, node: &ExprMethodCall) {
        if node.method == "set" && is_persistent_chain(&node.receiver) {
            if let Some(arg) = node.args.first() {
                let key_str = expr_to_string(arg);
                if !key_str.is_empty() {
                    self.keys.push(key_str);
                }
            }
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

#[derive(Default)]
struct ExtendTtlFinder {
    keys: Vec<String>,
}

impl<'a> Visit<'_> for ExtendTtlFinder {
    fn visit_expr_method_call(&mut self, node: &ExprMethodCall) {
        if node.method == "extend_ttl" && is_persistent_chain(&node.receiver) {
            if let Some(arg) = node.args.first() {
                let key_str = expr_to_string(arg);
                if !key_str.is_empty() {
                    self.keys.push(key_str);
                }
            }
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn is_persistent_chain(expr: &Expr) -> bool {
    matches!(expr, Expr::MethodCall(mc) if mc.method == "persistent")
}

fn expr_to_string(expr: &Expr) -> String {
    match expr {
        Expr::Reference(r) => expr_to_string(&r.expr),
        Expr::Path(ep) => ep
            .path
            .segments
            .iter()
            .map(|s| s.ident.to_string())
            .collect::<Vec<_>>()
            .join("::"),
        Expr::Call(c) => {
            if let Expr::Path(ep) = &*c.func {
                let fn_name = ep
                    .path
                    .segments
                    .iter()
                    .map(|s| s.ident.to_string())
                    .collect::<Vec<_>>()
                    .join("::");
                let args: Vec<String> = c.args.iter().map(expr_to_string).collect();
                format!("{}::({})", fn_name, args.join(","))
            } else {
                String::new()
            }
        }
        _ => String::new(),
    }
}

fn is_test_attr(attr: &Attribute) -> bool {
    if let Meta::Path(p) = &attr.meta {
        p.is_ident("test") || p.is_ident("should_panic")
    } else {
        false
    }
}
