import {RemovalPolicy, Stack, StackProps} from 'aws-cdk-lib';
import {Construct} from 'constructs';
import * as ec2 from "aws-cdk-lib/aws-ec2";

export class VpcPluralsightStack extends Stack {
    constructor(scope: Construct, id: string, props?: StackProps) {
        super(scope, id, props);

        /* Create a VPC to act as public facing part of infra */
        const publicVpc = new ec2.Vpc(this, "PublicVpc", {
            vpcName: "web-vpc",
            cidr: "10.1.0.0/16",
            // If left undefined CDK tries to create default subnets which causes conflict and errors
            // Empty array prevents this
            subnetConfiguration: []
        });
        publicVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a public subnet which holds the public facing parts of a web app */
        const publicSubnet = new ec2.Subnet(this, "PublicSubnet", {
            vpcId: publicVpc.vpcId,
            availabilityZone: "eu-west-1a",
            cidrBlock: "10.1.254.0/24"
        });
        publicSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a route table tied to the public VPC */
        const publicRouteTable = new ec2.CfnRouteTable(this, "PublicRouteTable", {
            vpcId: publicVpc.vpcId
        });
        publicRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicSubnetRouteTableAssociation =
            new ec2.CfnSubnetRouteTableAssociation(this, "PublicRouteTableSubnetAssociation1", {
                subnetId: publicSubnet.subnetId,
                routeTableId: publicRouteTable.attrRouteTableId
            });
        publicSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create an internet gateway which allow public VPC to access the outside world and vice versa */
        const publicInternetGateway = new ec2.CfnInternetGateway(this, "PublicInternetGateway");
        publicInternetGateway.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicVpcIgwAttachment = new ec2.CfnVPCGatewayAttachment(this, "PublicVpcIgwAttachment", {
            vpcId: publicVpc.vpcId,
            internetGatewayId: publicInternetGateway.attrInternetGatewayId
        });
        publicVpcIgwAttachment.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* cidr block 0.0.0.0/0 means all IPV4 traffic should get access to internet ingress and egress */
        const route = new ec2.CfnRoute(this, "PublicInternetAccessRoute", {
            routeTableId: publicRouteTable.attrRouteTableId,
            destinationCidrBlock: "0.0.0.0/0",
            gatewayId: publicInternetGateway.attrInternetGatewayId
        });
        route.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a new security group attached to the public facing VPC.
        * Allow SSH access into this VPC using a specific IP range 24.96.0.0/16
        * Allow any ipv4 or ipv6 address to connect to this VPC */
        const publicSecurityGroup = new ec2.SecurityGroup(this, "PublicSecurityGroup", {
            vpc: publicVpc,
            securityGroupName: "web-pub-sg",
            description: "Public VPC security group",
            // Allow the VPC to make connections to the outside world.
            // True by default but making explicit here
            allowAllOutbound: true
        });
        publicSecurityGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
        publicSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("24.96.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from IP range 24.96.0.0/16"
        );
        publicSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.tcp(80),
            "Allow access into this public VPC from any ipv4 address"
        );
        publicSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv6(),
            ec2.Port.tcp(80),
            "Allow access into this public VPC from any ipv6 address"
        );

        /* Create a keypair to allow SSH access to a running EC2 instance */
        const sshKeyPair = new ec2.CfnKeyPair(this, "ssh-keypair", {
            keyName: "public-ssh-key-pair"
        });
        sshKeyPair.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const publicEc2Instance = new ec2.Instance(this, "public-ec2-instance", {
            vpc: publicVpc,
            keyName: sshKeyPair.keyName,
            vpcSubnets: {subnets: [publicSubnet]},
            privateIpAddress: "10.1.254.10",
            instanceType: new ec2.InstanceType("t2.micro"),
            machineImage: ec2.MachineImage.latestAmazonLinux(),
            instanceName: "public-ec2-instance",
            securityGroup: publicSecurityGroup
        });
        publicEc2Instance.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Creates a new elastic IP and associates it to the EC2 instance tied to the public VPC.
        * This gives the instance a static ipv4 address which can be hit by outside traffic */
        const publicIpv4Address = new ec2.CfnEIP(this, "public-elastic-ip");
        publicIpv4Address.applyRemovalPolicy(RemovalPolicy.DESTROY);
        const publicElasticIpVpcAssociation = new ec2.CfnEIPAssociation(this, "public-elastic-ip-network-interface-assc", {
            instanceId: publicEc2Instance.instanceId,
            allocationId: publicIpv4Address.attrAllocationId
        });
        publicElasticIpVpcAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a VPC to act as shared private part of infra */
        const sharedVpc = new ec2.Vpc(this, "SharedVpc", {
            vpcName: "shared-vpc",
            cidr: "10.2.0.0/16",
            // If left undefined CDK tries to create default subnets which causes conflict and errors
            // Empty array prevents this
            subnetConfiguration: []
        });
        sharedVpc.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a subnet which holds the private database */
        const databaseSubnet = new ec2.Subnet(this, "DatabaseSubnet", {
            vpcId: sharedVpc.vpcId,
            availabilityZone: "eu-west-1a", // Keep zone same as public VPC. Different zones will still work but AWS will charge more
            cidrBlock: "10.2.2.0/24"
        });
        databaseSubnet.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a route table tied to the shared VPC */
        const sharedVpcRouteTable = new ec2.CfnRouteTable(this, "SharedRouteTable", {
            vpcId: sharedVpc.vpcId
        });
        sharedVpcRouteTable.applyRemovalPolicy(RemovalPolicy.DESTROY);

        const sharedSubnetRouteTableAssociation =
            new ec2.CfnSubnetRouteTableAssociation(this, "SharedRouteTableSubnetAssociation", {
                subnetId: databaseSubnet.subnetId,
                routeTableId: sharedVpcRouteTable.attrRouteTableId
            });
        sharedSubnetRouteTableAssociation.applyRemovalPolicy(RemovalPolicy.DESTROY);

        /* Create a new security group attached to the database instance .
        * Allow SSH access into this VPC using a specific IP ranges 192.168.0.0/16 or 10.2.0.0/16
        * Allow public subnet MySQL access only.
        * Allow any ipv4 to ping instance */
        const databaseSecurityGroup = new ec2.SecurityGroup(this, "DatabaseSecurityGroup", {
            vpc: sharedVpc,
            securityGroupName: "database-sg",
            description: "Database security group",
            // Allow the VPC to make connections to the outside world.
            // True by default but making explicit here
            allowAllOutbound: true
        });
        databaseSecurityGroup.applyRemovalPolicy(RemovalPolicy.DESTROY);
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("192.168.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from IP range 192.168.0.0/16"
        );
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("10.2.0.0/16"),
            ec2.Port.tcp(22),
            "SSH access from IP range 10.2.0.0/16"
        );
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.ipv4("10.1.254.0/24"),
            ec2.Port.tcp(3306),
            "MySQL access from public subnet into database instance"
        );
        databaseSecurityGroup.addIngressRule(
            ec2.Peer.anyIpv4(),
            ec2.Port.icmpPing(),
            "Allow ICMP ping from any ipv4"
        );

        /* Instance representing database running in AWS. Using private VPC and database subnet
        * No EiP defined as we don't want to allow public access to this instance */
        const databaseEc2Instance = new ec2.Instance(this, "database-ec2-instance", {
            vpc: sharedVpc,
            keyName: sshKeyPair.keyName,
            vpcSubnets: {subnets: [databaseSubnet]},
            privateIpAddress: "10.2.2.41",
            instanceType: new ec2.InstanceType("t2.micro"),
            machineImage: ec2.MachineImage.latestAmazonLinux(),
            instanceName: "database-ec2-instance",
            securityGroup: databaseSecurityGroup
        });
        databaseEc2Instance.applyRemovalPolicy(RemovalPolicy.DESTROY);
    }
}
