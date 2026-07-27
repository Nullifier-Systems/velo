use std::path::Path;
use syn::{visit::Visit, *};

pub fn check(ast: &File, file_path: &Path) -> (u64, u64) {
    let mut visitor = RequireAuthVisitor::new(file_path);
    visitor.visit_file(ast);
    (visitor.warnings, visitor.errors)
}

struct RequireAuthVisitor<'a> {
    file_path: &'a Path,
    warnings: u64,
    errors: u64,
}

impl<'a> RequireAuthVisitor<'a> {
    fn new(file_path: &'a Path) -> Self {
        Self {
            file_path,
            warnings: 0,
            errors: 0,
        }
    }

    fn emit_warning(&mut self, fn_name: &str, params: &[String]) {
        println!(
            "  ⚠  {}: function `{}` has Address parameter(s) ({}) but no require_auth() call",
            self.file_path.display(),
            fn_name,
            params.join(", ")
        );
        println!(
            "     │  Soroban requires explicit require_auth() on Address parameters\n\
               │  to verify caller identity. Without it, anyone can impersonate\n\
               │  the address owner."
        );
        self.warnings += 1;
    }
}

impl<'a> Visit<'_> for RequireAuthVisitor<'a> {
    fn visit_item_fn(&mut self, node: &ItemFn) {
        if !matches!(node.vis, Visibility::Public(_)) {
            return;
        }
        if node.attrs.iter().any(|a| is_test_attr(a)) {
            return;
        }

        let fn_name = node.sig.ident.to_string();
        let addr_params = collect_address_params(&node.sig.inputs);
        if addr_params.is_empty() {
            return;
        }

        let mut auth_visitor = AuthCallVisitor::new(&addr_params);
        auth_visitor.visit_block(&node.block);
        if !auth_visitor.found {
            self.emit_warning(&fn_name, &addr_params);
        }
    }

    fn visit_impl_item_fn(&mut self, node: &ImplItemFn) {
        if !matches!(node.vis, Visibility::Public(_)) {
            return;
        }
        if node.attrs.iter().any(|a| is_test_attr(a)) {
            return;
        }

        let fn_name = node.sig.ident.to_string();
        let addr_params = collect_address_params(&node.sig.inputs);
        if addr_params.is_empty() {
            return;
        }

        let mut auth_visitor = AuthCallVisitor::new(&addr_params);
        auth_visitor.visit_block(&node.block);
        if !auth_visitor.found {
            self.emit_warning(&fn_name, &addr_params);
        }
    }
}

fn collect_address_params(
    inputs: &syn::punctuated::Punctuated<FnArg, syn::token::Comma>,
) -> Vec<String> {
    inputs
        .iter()
        .filter_map(|arg| {
            if let FnArg::Typed(pt) = arg {
                if is_address_type(&pt.ty) {
                    if let Pat::Ident(pi) = &*pt.pat {
                        return Some(pi.ident.to_string());
                    }
                }
            }
            None
        })
        .collect()
}

struct AuthCallVisitor {
    target_params: Vec<String>,
    found: bool,
}

impl AuthCallVisitor {
    fn new(targets: &[String]) -> Self {
        Self {
            target_params: targets.to_vec(),
            found: false,
        }
    }
}

impl<'a> Visit<'_> for AuthCallVisitor {
    fn visit_expr_method_call(&mut self, node: &ExprMethodCall) {
        if node.method == "require_auth" {
            if let Expr::Path(ep) = &*node.receiver {
                if let Some(ident) = ep.path.get_ident() {
                    if self.target_params.contains(&ident.to_string()) {
                        self.found = true;
                    }
                }
            }
        }
        syn::visit::visit_expr_method_call(self, node);
    }
}

fn is_address_type(ty: &Type) -> bool {
    match ty {
        Type::Path(tp) => tp
            .path
            .segments
            .last()
            .map(|s| s.ident == "Address")
            .unwrap_or(false),
        Type::Reference(tr) => is_address_type(&tr.elem),
        _ => false,
    }
}

fn is_test_attr(attr: &Attribute) -> bool {
    if let Meta::Path(p) = &attr.meta {
        p.is_ident("test") || p.is_ident("should_panic")
    } else {
        false
    }
}
