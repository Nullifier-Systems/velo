#![cfg(test)]

use session_account::{SessionAccount, SessionAccountClient};
use soroban_sdk::{testutils::Address as _, token, xdr, Address, Env};

fn i128_to_scval(v: i128) -> xdr::ScVal {
    xdr::ScVal::I128(xdr::Int128Parts {
        hi: (v >> 64) as i64,
        lo: v as u64,
    })
}

#[test]
fn test_integration_token_transfer_flows() {
    let env = Env::default();
    env.mock_all_auths();

    let main_account = Address::generate(&env);
    let session_account_addr = env.register(SessionAccount, ());
    let session_account_client = SessionAccountClient::new(&env, &session_account_addr);

    // Initialize session account with main_account
    session_account_client.initialize(&main_account);

    // Register token contract and mint tokens to session account
    let token_admin = Address::generate(&env);
    let token_contract = env.register_stellar_asset_contract_v2(token_admin.clone());
    let token_client = token::Client::new(&env, &token_contract.address());
    let token_admin_client = token::StellarAssetClient::new(&env, &token_contract.address());

    token_admin_client.mint(&session_account_addr, &200_000_000);

    let session_key = Address::generate(&env);
    let recipient = Address::generate(&env);
    let cap = 50_000_000i128; // 50 USDC cap

    // Create session key with 50 USDC cap, valid for 7 days
    env.mock_all_auths();
    session_account_client.create_session_key(&session_key, &cap, &7, &0);

    let account_sc: xdr::ScAddress = session_account_addr.clone().try_into().unwrap();
    let delegate_sc: xdr::ScAddress = session_key.clone().try_into().unwrap();
    let recipient_sc: xdr::ScAddress = recipient.clone().try_into().unwrap();
    let token_sc: xdr::ScAddress = token_contract.address().clone().try_into().unwrap();

    // 1. Valid transfer within cap succeeds (30 USDC)
    let transfer_30 = 30_000_000i128;
    env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::AddressWithDelegates(
            xdr::SorobanAddressCredentialsWithDelegates {
                address_credentials: xdr::SorobanAddressCredentials {
                    address: account_sc.clone(),
                    nonce: 1,
                    signature_expiration_ledger: 100,
                    signature: xdr::ScVal::Void,
                },
                delegates: std::vec![xdr::SorobanDelegateSignature {
                    address: delegate_sc.clone(),
                    signature: xdr::ScVal::Void,
                    nested_delegates: Default::default(),
                }]
                .try_into()
                .unwrap(),
            },
        ),
        root_invocation: xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: token_sc.clone(),
                function_name: xdr::StringM::try_from("transfer").unwrap().into(),
                args: std::vec![
                    xdr::ScVal::Address(account_sc.clone()),
                    xdr::ScVal::Address(recipient_sc.clone()),
                    i128_to_scval(transfer_30),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: Default::default(),
        },
    }]);

    token_client.transfer(&session_account_addr, &recipient, &transfer_30);
    assert_eq!(token_client.balance(&recipient), 30_000_000);
    assert_eq!(session_account_client.get_spent(&session_key), 30_000_000);

    // 2. Transfer exceeding cap fails with SpendingCapExceeded (attempt 30 USDC more, cumulative 60 USDC > 50 USDC cap)
    env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::AddressWithDelegates(
            xdr::SorobanAddressCredentialsWithDelegates {
                address_credentials: xdr::SorobanAddressCredentials {
                    address: account_sc.clone(),
                    nonce: 2,
                    signature_expiration_ledger: 100,
                    signature: xdr::ScVal::Void,
                },
                delegates: std::vec![xdr::SorobanDelegateSignature {
                    address: delegate_sc.clone(),
                    signature: xdr::ScVal::Void,
                    nested_delegates: Default::default(),
                }]
                .try_into()
                .unwrap(),
            },
        ),
        root_invocation: xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: token_sc.clone(),
                function_name: xdr::StringM::try_from("transfer").unwrap().into(),
                args: std::vec![
                    xdr::ScVal::Address(account_sc.clone()),
                    xdr::ScVal::Address(recipient_sc.clone()),
                    i128_to_scval(transfer_30),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: Default::default(),
        },
    }]);

    let cap_exceeded_res =
        token_client.try_transfer(&session_account_addr, &recipient, &transfer_30);
    assert!(cap_exceeded_res.is_err());

    // 3. Transfer after revocation fails
    let session_key2 = Address::generate(&env);
    let delegate_sc2: xdr::ScAddress = session_key2.clone().try_into().unwrap();

    env.mock_all_auths();
    session_account_client.create_session_key(&session_key2, &cap, &7, &0);
    session_account_client.revoke_session_key(&session_key2);

    let transfer_10 = 10_000_000i128;
    env.set_auths(&[xdr::SorobanAuthorizationEntry {
        credentials: xdr::SorobanCredentials::AddressWithDelegates(
            xdr::SorobanAddressCredentialsWithDelegates {
                address_credentials: xdr::SorobanAddressCredentials {
                    address: account_sc.clone(),
                    nonce: 3,
                    signature_expiration_ledger: 100,
                    signature: xdr::ScVal::Void,
                },
                delegates: std::vec![xdr::SorobanDelegateSignature {
                    address: delegate_sc2.clone(),
                    signature: xdr::ScVal::Void,
                    nested_delegates: Default::default(),
                }]
                .try_into()
                .unwrap(),
            },
        ),
        root_invocation: xdr::SorobanAuthorizedInvocation {
            function: xdr::SorobanAuthorizedFunction::ContractFn(xdr::InvokeContractArgs {
                contract_address: token_sc.clone(),
                function_name: xdr::StringM::try_from("transfer").unwrap().into(),
                args: std::vec![
                    xdr::ScVal::Address(account_sc.clone()),
                    xdr::ScVal::Address(recipient_sc.clone()),
                    i128_to_scval(transfer_10),
                ]
                .try_into()
                .unwrap(),
            }),
            sub_invocations: Default::default(),
        },
    }]);

    let revoked_res = token_client.try_transfer(&session_account_addr, &recipient, &transfer_10);
    assert!(revoked_res.is_err());
}
