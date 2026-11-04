# Bento licensing / 许可说明

Bento Source-Available License 1.0 is a **custom license**, not a standard
open-source license. [LICENSE](./LICENSE) contains the governing English terms.
This page explains them; it does not grant additional rights.

## What is permitted

- Free personal use of unmodified Bento.
- Ordinary internal workplace use of unmodified Bento, including at a company;
  managing your own paid work products does not license those files to Bento.
- Noncommercial modifications and free redistribution, subject to the source
  publication requirements and preserved notices.
- Voluntary donations with no exclusive features, access, or consideration.

## What requires separate permission

Selling or renting Bento or a modified version, charging for access or
software-based services, commercial bundling, and commercial development
require separate written permission from the relevant rights holders. This
includes paid client development and development for a business's internal
operations. Permission to use the unmodified app at work does not grant
permission for commercial development.

**Every source modification must be made public at the time it is made,
including private or personal changes. Source must be public before running
or testing the modified version.** Publish complete editable source, build
scripts and instructions, exact dependency versions, and matching revision
information under the same license. A private repository or a link to
unchanged upstream source does not satisfy this requirement. Do not publish
private keys, passwords, or user files; provide safe templates instead.

## Earlier MIT grants and third parties

The parent revision of the license-change commit,
[`69d38761500e981a7e867fdf74361c62ee32eb9e`](https://github.com/banduoba/bento/tree/69d38761500e981a7e867fdf74361c62ee32eb9e),
and releases made from that MIT-licensed history were offered under MIT.
The first license-change commit and subsequent covered contributions are
offered under the new terms to the extent their licensors can grant them.
The transition is not a revocation of MIT permissions for historical code.

Someone who relies only on previously MIT-licensed code can continue to use,
modify, and commercially distribute that code under MIT, including making
private changes. Merely downloading the same historical code from a newer
revision does not eliminate previously available permissions. The new
restrictions protect rights granted under the new license; they cannot
retroactively restrict the earlier code.

The project preserves its previous notice in
[LICENSES/Bento-legacy-MIT.txt](./LICENSES/Bento-legacy-MIT.txt). Preserve it
where the earlier code is included. Third-party libraries and other
separately licensed material keep their respective licenses; they are not
relicensed by Bento. For example, the search engine fsearch is MIT-licensed;
its copyright notice is retained in
[LICENSES/fsearch-MIT.txt](./LICENSES/fsearch-MIT.txt). These files are not an
exhaustive inventory of transitive dependencies: distributors must also
retain all notices required by the exact dependencies they ship.

Before submitting others' code, establish permission to include it and retain
its notices. Contributions are not copyright assignments. Separate commercial
permission must cover all relevant rights holders, not just the project name.

## 中文说明

这是 **Bento 自定义源码可用许可证**，不属于 OSI 认可的开源许可证。
英文 [LICENSE](./LICENSE) 为正式条文，本节为说明。

- 允许免费个人使用，也允许公司员工把未修改的 Bento 作为日常办公工具。
  使用 Bento 管理的文件、个人数据和工作成果，不会因此适用本许可证。
- 禁止未经另行书面授权售卖、出租、收费提供访问或软件功能服务、商业捆绑、
  商业二次开发；包括付费客户定制和为企业内部运营开发修改版。
  允许日常办公使用，不等于允许企业二次开发。
- **任何代码修改都必须在修改时公开完整对应源码，包括个人或私下修改；
  运行、测试前必须先公开。** 私有仓库不满足要求。必须保留相同条款、
  作者和第三方声明，提供可构建的源码、脚本、依赖版本和说明；分发二进制时
  须对应到准确的源码版本。无需公开个人文件、密码、私钥，应提供安全模板。
- 在继续使用、开发、提供或分发修改版期间，源码必须保持公开、免费，
  无需登录或逐个审批即可获取。公开源码不会解除商业限制。
- 历史 MIT 版本的既有授权继续有效，无法通过本次修改追溯收回。
  只使用早前 MIT 代码的人仍可依据 MIT 商用、私下修改或继续分发。
  新限制只作用于相关权利人根据新许可证授出的权利。
- 第三方组件保留原协议，不能统一替换为 Bento 的协议；保留历史 MIT
  声明和实际分发依赖所要求的全部声明。

本许可证为项目定制条款；正式采用和对外依赖其法律效果前，应由律师复核。
