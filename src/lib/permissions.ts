/**
 * 动作级权限矩阵（W20）。
 *
 * 为什么它是纯函数、不查库：
 *   W19 的租户检查（orgId）是**行级**的 —— "这行数据归哪个租户"，答案在数据库里，
 *   所以必须进 where。W20 的动作权限是**动作级**的 —— "这个动作允许这个角色做吗"，
 *   答案只取决于角色和资源属性，不需要查库。两个维度混在一起写（比如把 role 塞进
 *   where、或者在这里再查一次库），两边都会变难读，而且容易漏掉一边。
 *
 * 为什么要 fail closed（未知动作返回 false）：
 *   以后加新动作时，如果忘了在这个 switch 里登记，宁可全部拒绝（马上会被发现）
 *   也不要全部放行（等出事才发现）。默认放行的 switch 是权限系统里最经典的坑。
 */

/** 调用方身份：userId 与 role 都来自 requireTenant()，永远不来自表单。 */
export type Principal = {
  userId: string;
  role: string; // owner | member
};

/** kb:rename / kb:delete 需要知道资源是谁建的 —— 用 W19 埋的 createdBy。 */
export type KbResource = {
  createdBy: string;
};

export type OrgAction =
  // 组织内全员可做
  | 'kb:create'
  | 'document:upload'
  | 'document:reindex'
  | 'document:delete'
  | 'conversation:create'
  | 'conversation:delete'
  // 角色相关
  | 'kb:rename'
  | 'kb:delete'
  | 'invite:create'
  | 'member:list'
  | 'member:remove';

export function can(principal: Principal, action: OrgAction, resource?: KbResource): boolean {
  const isOwner = principal.role === 'owner';

  switch (action) {
    /**
     * 删 / 改知识库：owner 全通，member 只能动**自己创建**的。
     * 这是 createdBy 字段的第一个消费者 —— W19 留它就是为了这一天。
     */
    case 'kb:rename':
    case 'kb:delete':
      return isOwner || resource?.createdBy === principal.userId;

    // owner 专属：拉人、看名单、踢人
    case 'invite:create':
    case 'member:list':
    case 'member:remove':
      return isOwner;

    // 组织内全员：日常使用
    case 'kb:create':
    case 'document:upload':
    case 'document:reindex':
    case 'document:delete':
    case 'conversation:create':
    case 'conversation:delete':
      return true;

    default:
      // fail closed：见文件头注释
      return false;
  }
}
