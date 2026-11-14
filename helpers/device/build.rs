//! Generates the helper protocol from `proto/` with protox, a protobuf compiler in Rust, so the
//! build needs no `protoc` binary.

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let proto_root = "../../proto";
    println!("cargo:rerun-if-changed={proto_root}");
    let descriptors = protox::compile(["lazurio/app/helper/v1/helper.proto"], [proto_root])?;
    prost_build::Config::new().compile_fds(descriptors)?;
    Ok(())
}
